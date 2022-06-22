/*eslint-env node*/
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const child_process = require("child_process");
const crypto = require("crypto");
const zlib = require("zlib");
const readline = require("readline");
const request = require("request");

const globby = require("globby");
const gulpTap = require("gulp-tap");
const open = require("open");
const rimraf = require("rimraf");
const glslStripComments = require("glsl-strip-comments");
const mkdirp = require("mkdirp");
const mergeStream = require("merge-stream");
const streamToPromise = require("stream-to-promise");
const gulp = require("gulp");
const gulpInsert = require("gulp-insert");
const gulpZip = require("gulp-zip");
const gulpRename = require("gulp-rename");
const gulpReplace = require("gulp-replace");
const Promise = require("bluebird");
const Karma = require("karma");
const yargs = require("yargs");
const AWS = require("aws-sdk");
const mime = require("mime");
const cleanCSS = require("gulp-clean-css");
const typescript = require("typescript");
const esbuild = require("esbuild");
const istanbul = require("istanbul-lib-instrument");

const packageJson = require("./package.json");
let version = packageJson.version;
if (/\.0$/.test(version)) {
  version = version.substring(0, version.length - 2);
}

const karmaConfigFile = path.join(__dirname, "Specs/karma.conf.cjs");
const travisDeployUrl =
  "http://cesium-dev.s3-website-us-east-1.amazonaws.com/cesium/";

//Gulp doesn't seem to have a way to get the currently running tasks for setting
//per-task variables.  We use the command line argument here to detect which task is being run.
const taskName = process.argv[2];
const noDevelopmentGallery = taskName === "release" || taskName === "make-zip";
const verbose = yargs.argv.verbose;

let concurrency = yargs.argv.concurrency;
if (!concurrency) {
  concurrency = os.cpus().length;
}
const sourceFiles = [
  "Source/**/*.js",
  "!Source/*.js",
  "!Source/Workers/**",
  "!Source/WorkersES6/**",
  "Source/WorkersES6/createTaskProcessorWorker.js",
  "!Source/ThirdParty/Workers/**",
  "!Source/ThirdParty/google-earth-dbroot-parser.js",
  "!Source/ThirdParty/_*",
];

const filesToClean = [
  "Source/Cesium.js",
  "Source/Shaders/**/*.js",
  "Source/Workers/**",
  "!Source/Workers/cesiumWorkerBootstrapper.js",
  "!Source/Workers/transferTypedArrayTest.js",
  "Source/ThirdParty/Shaders/*.js",
  "Source/**/*.d.ts",
  "Specs/SpecList.js",
  "Specs/jasmine/**",
  "Apps/Sandcastle/jsHintOptions.js",
  "Apps/Sandcastle/gallery/gallery-index.js",
  "Apps/Sandcastle/templates/bucket.css",
  "Cesium-*.zip",
  "cesium-*.tgz",
];

const workerSourceFiles = ["Source/WorkersES6/**"];
const watchedSpecFiles = [
  "Specs/**/*Spec.js",
  "Specs/*.js",
  "Specs/TestWorkers/*.js",
];
const testWorkers = ["Specs/TestWorkers/*.js"];
const cssFiles = "Source/**/*.css";
const shaderFiles = [
  "Source/Shaders/**/*.glsl",
  "Source/ThirdParty/Shaders/*.glsl",
];

const copyrightHeader = fs.readFileSync(
  path.join("Source", "copyrightHeader.js"),
  "utf8"
);

function escapeCharacters(token) {
  return token.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

function constructRegex(pragma, exclusive) {
  const prefix = exclusive ? "exclude" : "include";
  pragma = escapeCharacters(pragma);

  const s =
    `[\\t ]*\\/\\/>>\\s?${prefix}Start\\s?\\(\\s?(["'])${pragma}\\1\\s?,\\s?pragmas\\.${pragma}\\s?\\)\\s?;?` +
    // multiline code block
    `[\\s\\S]*?` +
    // end comment
    `[\\t ]*\\/\\/>>\\s?${prefix}End\\s?\\(\\s?(["'])${pragma}\\2\\s?\\)\\s?;?\\s?[\\t ]*\\n?`;

  return new RegExp(s, "gm");
}

const pragmas = {
  debug: false,
};
const stripPragmaPlugin = {
  name: "strip-pragmas",
  setup: (build) => {
    const readFile = Promise.promisify(fs.readFile);
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");

      try {
        for (const key in pragmas) {
          if (pragmas.hasOwnProperty(key)) {
            source = source.replace(constructRegex(key, pragmas[key]), "");
          }
        }

        return { contents: source };
      } catch (e) {
        return {
          errors: {
            text: e.message,
          },
        };
      }
    });
  },
};

// Print an esbuild warning
function printBuildWarning({ location, text }) {
  const { column, file, line, lineText, suggestion } = location;

  let message = `\n
  > ${file}:${line}:${column}: warning: ${text}
  ${lineText}
  `;

  if (suggestion && suggestion !== "") {
    message += `\n${suggestion}`;
  }

  console.log(message);
}

// Ignore `eval` warnings in third-party code we don't have control over
function handleBuildWarnings(result) {
  for (const warning of result.warnings) {
    if (
      !warning.location.file.includes("protobufjs.js") &&
      !warning.location.file.includes("Build/Cesium")
    ) {
      printBuildWarning(warning);
    }
  }
}

const esbuildBaseConfig = {
  target: "es2018",
  legalComments: "inline",
  banner: {
    js: copyrightHeader,
  },
};

async function buildCesiumJs(options) {
  const css = globby.sync(cssFiles);

  const buildConfig = {
    ...esbuildBaseConfig,
    entryPoints: ["Source/Cesium.js"],
    bundle: true,
    minify: options.minify,
    sourcemap: options.sourcemap,
    external: ["https", "http", "url", "zlib"],
    plugins: options.removePragmas ? [stripPragmaPlugin] : undefined,
    incremental: options.incremental,
    logLevel: "error", // print errors immediately, and collect warnings so we can filter out known ones
  };

  // Build ESM
  const result = await esbuild.build({
    ...buildConfig,
    format: "esm",
    outfile: path.join(options.path, "index.js"),
  });

  handleBuildWarnings(result);

  const results = [result];

  // Copy and minify CSS and third party
  await esbuild.build({
    ...esbuildBaseConfig,
    entryPoints: [
      "Source/ThirdParty/google-earth-dbroot-parser.js",
      ...css, // Load and optionally minify css
    ],
    loader: {
      ".gif": "text",
      ".png": "text",
    },
    minify: options.minify,
    sourcemap: options.sourcemap,
    outdir: options.path,
  });

  // Build IIFE
  if (options.iife) {
    const result = await esbuild.build({
      ...buildConfig,
      format: "iife",
      globalName: "Cesium",
      outfile: path.join(options.path, "Cesium.js"),
    });

    handleBuildWarnings(result);

    results.push(result);
  }

  if (options.node) {
    const result = await esbuild.build({
      ...buildConfig,
      format: "cjs",
      platform: "node",
      sourcemap: false,
      outfile: path.join(options.path, "index.cjs"),
    });

    handleBuildWarnings(result);
    results.push(result);
  }

  return results;
}

/**
 * Bundles the workers and outputs to the Source/Workers directory
 * @param {Object} options
 * @param {boolean} [options.minify=false] true if the worker output should be minified
 * @param {boolean} [options.sourcemap=false] true if a sourcemap should be generated
 * @param {String} options.path true if the worker output should be minified
 * @returns {Promise.<Object>} esbuild result
 */
async function createWorkers(options) {
  const workersES6 = globby.sync(workerSourceFiles);
  const workers = globby.sync([
    "Source/Workers/**",
    "Source/ThirdParty/Workers/**",
  ]);

  const result = esbuild.build({
    ...esbuildBaseConfig,
    entryPoints: workersES6,
    bundle: true,
    globalName: "CesiumWorker",
    format: "iife",
    minify: options.minify,
    sourcemap: options.sourcemap,
    external: ["https", "http", "zlib"],
    outdir: path.join(options.path, "Workers"),
    plugins: options.removePragmas ? [stripPragmaPlugin] : undefined,
    incremental: options.incremental,
  });

  await esbuild.build({
    ...esbuildBaseConfig,
    entryPoints: workers,
    outdir: path.join(options.path),
    outbase: "Source", // Maintain existing file paths
    // Only return results from ES6 workers. Third party workers are unlikely to change.
  });

  return result;
}

const externalResolvePlugin = {
  name: "external-cesium",
  setup: (build) => {
    build.onResolve({ filter: new RegExp(`Cesium\.js$`) }, () => {
      return {
        path: "Cesium",
        namespace: "external-cesium",
      };
    });

    build.onLoad(
      {
        filter: new RegExp(`^Cesium$`),
        namespace: "external-cesium",
      },
      () => {
        const contents = `module.exports = Cesium`;
        return {
          contents,
        };
      }
    );
  },
};

async function buildSpecs(options) {
  options = options || {};

  const results = await esbuild.build({
    entryPoints: [
      "Specs/spec-main.js",
      "Specs/SpecList.js",
      "Specs/karma-main.js",
    ],
    bundle: true,
    format: "esm",
    sourcemap: true,
    target: "es6",
    outdir: path.join("Build", "Specs"),
    plugins: [externalResolvePlugin],
    incremental: options.incremental,
  });

  const testWorkerFiles = globby.sync(testWorkers);
  await esbuild.build({
    entryPoints: testWorkerFiles,
    bundle: true,
    globalName: "CesiumWorker",
    format: "iife",
    target: "es6",
    sourcemap: true,
    external: ["https", "http", "zlib"],
    outdir: path.join("Build", "Specs", "TestWorkers"),
    // Only rebuild if Spec files change. Test workers are unlikely to change.
  });

  return results;
}

async function build(options) {
  options = options || {};
  mkdirp.sync("Build");

  const outputDirectory = path.join(
    "Build",
    `Cesium${!options.minify ? "Unminified" : ""}`
  );
  rimraf.sync(outputDirectory);

  fs.writeFileSync(
    "Build/package.json",
    JSON.stringify({
      type: "commonjs",
    }),
    "utf8"
  );

  glslToJavaScript(options.minify, "Build/minifyShaders.state");
  createCesiumJs();
  createSpecList();
  createJsHintOptions();
  return Promise.join(
    buildCesiumJs({
      minify: options.minify,
      iife: true,
      sourcemap: options.sourcemap,
      removePragmas: options.removePragmas,
      path: outputDirectory,
      node: options.node,
    }),
    createWorkers({
      minify: options.minify,
      sourcemap: options.sourcemap,
      path: outputDirectory,
      removePragmas: options.removePragmas,
    }),
    createGalleryList(),
    buildSpecs()
  ).then(() => {
    return copyAssets({
      outputDirectory: outputDirectory,
    });
  });
}

gulp.task("build", function () {
  const argv = yargs.argv;
  const minify = argv.minify ? argv.minify : false;
  const removePragmas = argv.pragmas ? argv.pragmas : false;
  const sourcemap = argv.sourcemap ? argv.sourcemap : true;
  const node = argv.node ? argv.node : true;

  return build({
    minify: minify,
    removePragmas: removePragmas,
    sourcemap: sourcemap,
    node: node,
  });
});

gulp.task(
  "build-watch",
  gulp.series("build", async function () {
    const argv = yargs.argv;
    const minify = argv.minify ? argv.minify : false;
    const removePragmas = argv.pragmas ? argv.pragmas : false;
    const sourcemap = argv.sourcemap ? argv.sourcemap : true;

    const outputDirectory = path.join(
      "Build",
      `Cesium${!minify ? "Unminified" : ""}`
    );

    let [esmResult, iifeResult, cjsResult] = await buildCesiumJs({
      minify: minify,
      path: outputDirectory,
      removePragmas: removePragmas,
      sourcemap: sourcemap,
      incremental: true,
    });

    let specResult = await buildSpecs({
      incremental: true,
    });

    let workerResult = await createWorkers({
      minify: minify,
      path: outputDirectory,
      removePragmas: removePragmas,
      sourcemap: sourcemap,
      incremental: true,
    });

    gulp.watch(shaderFiles, async () => {
      glslToJavaScript(minify, "Build/minifyShaders.state");
      esmResult = await esmResult.rebuild();

      if (iifeResult) {
        iifeResult = await iifeResult.rebuild();
      }

      if (cjsResult) {
        cjsResult = await cjsResult.rebuild();
      }
    });

    gulp.watch(sourceFiles, async () => {
      esmResult = await esmResult.rebuild();

      if (iifeResult) {
        iifeResult = await iifeResult.rebuild();
      }

      if (cjsResult) {
        cjsResult = await cjsResult.rebuild();
      }
    });

    gulp.watch(
      watchedSpecFiles,
      {
        events: ["add", "unlink"],
      },
      async () => {
        createSpecList();
        specResult = await specResult.rebuild();
      }
    );

    gulp.watch(
      watchedSpecFiles,
      {
        events: ["change"],
      },
      async () => {
        specResult = await specResult.rebuild();
      }
    );

    gulp.watch(workerSourceFiles, async () => {
      workerResult = await workerResult.rebuild();
    });

    process.on("SIGINT", () => {
      // Free up resources
      esmResult.rebuild.dispose();

      if (iifeResult) {
        iifeResult.rebuild.dispose();
      }

      if (cjsResult) {
        cjsResult.rebuild.dispose();
      }

      specResult.rebuild.dispose();
      workerResult.rebuild.dispose();
      process.exit(0);
    });
  })
);

gulp.task("build-ts", function () {
  createTypeScriptDefinitions();
  return Promise.resolve();
});

gulp.task("build-apps", function () {
  return Promise.join(buildCesiumViewer(), buildSandcastle());
});

gulp.task("build-third-party", function () {
  return generateThirdParty();
});

gulp.task("clean", function (done) {
  rimraf.sync("Build");
  globby.sync(filesToClean).forEach(function (file) {
    rimraf.sync(file);
  });
  done();
});

function cloc() {
  let cmdLine;

  //Run cloc on primary Source files only
  const source = new Promise(function (resolve, reject) {
    cmdLine =
      "npx cloc" +
      " --quiet --progress-rate=0" +
      " Source/ --exclude-dir=Assets,ThirdParty,Workers --not-match-f=copyrightHeader.js";

    child_process.exec(cmdLine, function (error, stdout, stderr) {
      if (error) {
        console.log(stderr);
        return reject(error);
      }
      console.log("Source:");
      console.log(stdout);
      resolve();
    });
  });

  //If running cloc on source succeeded, also run it on the tests.
  return source.then(function () {
    return new Promise(function (resolve, reject) {
      cmdLine =
        "npx cloc" +
        " --quiet --progress-rate=0" +
        " Specs/ --exclude-dir=Data";
      child_process.exec(cmdLine, function (error, stdout, stderr) {
        if (error) {
          console.log(stderr);
          return reject(error);
        }
        console.log("Specs:");
        console.log(stdout);
        resolve();
      });
    });
  });
}

gulp.task("cloc", gulp.series("clean", cloc));

gulp.task("default", gulp.series("build"));

gulp.task("prepare", function () {
  // Copy Draco3D files from node_modules into Source
  fs.copyFileSync(
    "node_modules/draco3d/draco_decoder_nodejs.js",
    "Source/ThirdParty/Workers/draco_decoder_nodejs.js"
  );
  fs.copyFileSync(
    "node_modules/draco3d/draco_decoder.wasm",
    "Source/ThirdParty/draco_decoder.wasm"
  );
  // Copy pako and zip.js worker files to Source/ThirdParty
  fs.copyFileSync(
    "node_modules/pako/dist/pako_inflate.min.js",
    "Source/ThirdParty/Workers/pako_inflate.min.js"
  );
  fs.copyFileSync(
    "node_modules/pako/dist/pako_deflate.min.js",
    "Source/ThirdParty/Workers/pako_deflate.min.js"
  );
  fs.copyFileSync(
    "node_modules/@zip.js/zip.js/dist/z-worker-pako.js",
    "Source/ThirdParty/Workers/z-worker-pako.js"
  );

  // Copy jasmine runner files into Specs
  return globby([
    "node_modules/jasmine-core/lib/jasmine-core",
    "!node_modules/jasmine-core/lib/jasmine-core/example",
  ]).then(function (files) {
    const stream = gulp.src(files).pipe(gulp.dest("Specs/jasmine"));
    return streamToPromise(stream);
  });
});

//Builds the documentation
function generateDocumentation() {
  const argv = yargs.argv;
  const generatePrivateDocumentation = argv.private ? "--private" : "";

  child_process.execSync(
    `npx jsdoc --configure Tools/jsdoc/conf.json --pedantic ${generatePrivateDocumentation}`,
    {
      stdio: "inherit",
      env: Object.assign({}, process.env, { CESIUM_VERSION: version }),
    }
  );

  const stream = gulp
    .src("Documentation/Images/**")
    .pipe(gulp.dest("Build/Documentation/Images"));

  return streamToPromise(stream);
}
gulp.task("build-doc", generateDocumentation);

gulp.task("build-doc-watch", function () {
  return generateDocumentation().then(function () {
    console.log("Listening for changes in documentation...");
    return gulp.watch(sourceFiles, gulp.series("build-doc"));
  });
});

gulp.task(
  "release",
  gulp.series(
    function () {
      return build({
        minify: false,
        removePragmas: false,
        node: true,
      });
    },
    function () {
      return build({
        minify: true,
        removePragmas: true,
        node: true,
      });
    },
    "build-ts",
    generateDocumentation
  )
);

gulp.task(
  "make-zip",
  gulp.series("release", function () {
    //For now we regenerate the JS glsl to force it to be unminified in the release zip
    //See https://github.com/CesiumGS/cesium/pull/3106#discussion_r42793558 for discussion.
    glslToJavaScript(false, "Build/minifyShaders.state");

    // Remove prepare step from package.json to avoid running "prepare" an extra time.
    delete packageJson.scripts.prepare;

    // Remove build and transform tasks since they do not function as intended from within the release zip
    delete packageJson.scripts.build;
    delete packageJson.scripts["build-watch"];
    delete packageJson.scripts["build-ts"];
    delete packageJson.scripts["build-third-party"];
    delete packageJson.scripts["build-apps"];
    delete packageJson.scripts.clean;
    delete packageJson.scripts.cloc;
    delete packageJson.scripts["build-doc"];
    delete packageJson.scripts["build-doc-watch"];
    delete packageJson.scripts["make-zip"];
    delete packageJson.scripts.release;
    delete packageJson.scripts.prettier;

    // Remove deploy tasks
    delete packageJson.scripts["deploy-s3"];
    delete packageJson.scripts["deploy-status"];
    delete packageJson.scripts["deploy-set-version"];

    fs.writeFileSync(
      "./Build/package.noprepare.json",
      JSON.stringify(packageJson, null, 2)
    );

    const packageJsonSrc = gulp
      .src("Build/package.noprepare.json")
      .pipe(gulpRename("package.json"));

    const builtSrc = gulp.src(
      [
        "Build/Cesium/**",
        "Build/CesiumUnminified/**",
        "Build/Documentation/**",
        "Build/package.json",
        // TODO: Include built specs? Shouldn't be too big
      ],
      {
        base: ".",
      }
    );

    const staticSrc = gulp.src(
      [
        "Apps/**",
        "Apps/**/.eslintrc.json",
        "!Apps/Sandcastle/gallery/development/**",
        "Source/**",
        "Source/**/.eslintrc.json",
        "Specs/**",
        "Specs/**/.eslintrc.json",
        "ThirdParty/**",
        "Tools/eslint-config-cesium/**",
        "favicon.ico",
        ".eslintignore",
        ".eslintrc.json",
        ".gulp.json",
        ".prettierignore",
        "gulpfile.cjs",
        "server.cjs",
        "index.cjs",
        "LICENSE.md",
        "CHANGES.md",
        "README.md",
        "web.config",
      ],
      {
        base: ".",
      }
    );

    const indexSrc = gulp
      .src("index.release.html")
      .pipe(gulpRename("index.html"));

    return mergeStream(packageJsonSrc, builtSrc, staticSrc, indexSrc)
      .pipe(
        gulpTap(function (file) {
          // Work around an issue with gulp-zip where archives generated on Windows do
          // not properly have their directory executable mode set.
          // see https://github.com/sindresorhus/gulp-zip/issues/64#issuecomment-205324031
          if (file.isDirectory()) {
            file.stat.mode = parseInt("40777", 8);
          }
        })
      )
      .pipe(gulpZip(`Cesium-${version}.zip`))
      .pipe(gulp.dest("."))
      .on("finish", function () {
        rimraf.sync("./Build/package.noprepare.json");
      });
  })
);

function isTravisPullRequest() {
  return (
    process.env.TRAVIS_PULL_REQUEST !== undefined &&
    process.env.TRAVIS_PULL_REQUEST !== "false"
  );
}

gulp.task("deploy-s3", function (done) {
  if (isTravisPullRequest()) {
    console.log("Skipping deployment for non-pull request.");
    done();
    return;
  }

  const argv = yargs
    .usage("Usage: deploy-s3 -b [Bucket Name] -d [Upload Directory]")
    .demand(["b", "d"]).argv;

  const uploadDirectory = argv.d;
  const bucketName = argv.b;
  const cacheControl = argv.c ? argv.c : "max-age=3600";

  if (argv.confirm) {
    // skip prompt for travis
    deployCesium(bucketName, uploadDirectory, cacheControl, done);
    return;
  }

  const iface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // prompt for confirmation
  iface.question(
    `Files from your computer will be published to the ${bucketName} bucket. Continue? [y/n] `,
    function (answer) {
      iface.close();
      if (answer === "y") {
        deployCesium(bucketName, uploadDirectory, cacheControl, done);
      } else {
        console.log("Deploy aborted by user.");
        done();
      }
    }
  );
});

// Deploy cesium to s3
function deployCesium(bucketName, uploadDirectory, cacheControl, done) {
  const readFile = Promise.promisify(fs.readFile);
  const gzip = Promise.promisify(zlib.gzip);
  const concurrencyLimit = 2000;

  const s3 = new AWS.S3({
    maxRetries: 10,
    retryDelayOptions: {
      base: 500,
    },
  });

  const existingBlobs = [];
  let totalFiles = 0;
  let uploaded = 0;
  let skipped = 0;
  const errors = [];

  const prefix = `${uploadDirectory}/`;
  return listAll(s3, bucketName, prefix, existingBlobs)
    .then(function () {
      return globby(
        [
          "Apps/**",
          "Build/**",
          "Source/**",
          "Specs/**",
          "ThirdParty/**",
          "*.md",
          "favicon.ico",
          "gulpfile.cjs",
          "index.html",
          "package.json",
          "server.cjs",
          "web.config",
          "*.zip",
          "*.tgz",
        ],
        {
          dot: true, // include hidden files
        }
      );
    })
    .then(function (files) {
      return Promise.map(
        files,
        function (file) {
          const blobName = `${uploadDirectory}/${file}`;
          const mimeLookup = getMimeType(blobName);
          const contentType = mimeLookup.type;
          const compress = mimeLookup.compress;
          const contentEncoding = compress ? "gzip" : undefined;
          let etag;

          totalFiles++;

          return readFile(file)
            .then(function (content) {
              if (!compress) {
                return content;
              }

              const alreadyCompressed =
                content[0] === 0x1f && content[1] === 0x8b;
              if (alreadyCompressed) {
                console.log(
                  `Skipping compressing already compressed file: ${file}`
                );
                return content;
              }

              return gzip(content);
            })
            .then(function (content) {
              // compute hash and etag
              const hash = crypto
                .createHash("md5")
                .update(content)
                .digest("hex");
              etag = crypto.createHash("md5").update(content).digest("base64");

              const index = existingBlobs.indexOf(blobName);
              if (index <= -1) {
                return content;
              }

              // remove files as we find them on disk
              existingBlobs.splice(index, 1);

              // get file info
              return s3
                .headObject({
                  Bucket: bucketName,
                  Key: blobName,
                })
                .promise()
                .then(function (data) {
                  if (
                    data.ETag !== `"${hash}"` ||
                    data.CacheControl !== cacheControl ||
                    data.ContentType !== contentType ||
                    data.ContentEncoding !== contentEncoding
                  ) {
                    return content;
                  }

                  // We don't need to upload this file again
                  skipped++;
                  return undefined;
                })
                .catch(function (error) {
                  errors.push(error);
                });
            })
            .then(function (content) {
              if (!content) {
                return;
              }

              if (verbose) {
                console.log(`Uploading ${blobName}...`);
              }
              const params = {
                Bucket: bucketName,
                Key: blobName,
                Body: content,
                ContentMD5: etag,
                ContentType: contentType,
                ContentEncoding: contentEncoding,
                CacheControl: cacheControl,
              };

              return s3
                .putObject(params)
                .promise()
                .then(function () {
                  uploaded++;
                })
                .catch(function (error) {
                  errors.push(error);
                });
            });
        },
        { concurrency: concurrencyLimit }
      );
    })
    .then(function () {
      console.log(
        `Skipped ${skipped} files and successfully uploaded ${uploaded} files of ${
          totalFiles - skipped
        } files.`
      );
      if (existingBlobs.length === 0) {
        return;
      }

      const objectsToDelete = [];
      existingBlobs.forEach(function (file) {
        //Don't delete generate zip files.
        if (!/\.(zip|tgz)$/.test(file)) {
          objectsToDelete.push({ Key: file });
        }
      });

      if (objectsToDelete.length > 0) {
        console.log(`Cleaning ${objectsToDelete.length} files...`);

        // If more than 1000 files, we must issue multiple requests
        const batches = [];
        while (objectsToDelete.length > 1000) {
          batches.push(objectsToDelete.splice(0, 1000));
        }
        batches.push(objectsToDelete);

        return Promise.map(
          batches,
          function (objects) {
            return s3
              .deleteObjects({
                Bucket: bucketName,
                Delete: {
                  Objects: objects,
                },
              })
              .promise()
              .then(function () {
                if (verbose) {
                  console.log(`Cleaned ${objects.length} files.`);
                }
              });
          },
          { concurrency: concurrency }
        );
      }
    })
    .catch(function (error) {
      errors.push(error);
    })
    .then(function () {
      if (errors.length === 0) {
        done();
        return;
      }

      console.log("Errors: ");
      errors.map(function (e) {
        console.log(e);
      });
      done(1);
    });
}

function getMimeType(filename) {
  const mimeType = mime.getType(filename);
  if (mimeType) {
    //Compress everything except zipfiles, binary images, and video
    let compress = !/^(image\/|video\/|application\/zip|application\/gzip)/i.test(
      mimeType
    );
    if (mimeType === "image/svg+xml") {
      compress = true;
    }
    return { type: mimeType, compress: compress };
  }

  //Non-standard mime types not handled by mime
  if (/\.(glsl|LICENSE|config|state)$/i.test(filename)) {
    return { type: "text/plain", compress: true };
  } else if (/\.(czml|topojson)$/i.test(filename)) {
    return { type: "application/json", compress: true };
  } else if (/\.tgz$/i.test(filename)) {
    return { type: "application/octet-stream", compress: false };
  }

  // Handle dotfiles, such as .jshintrc
  const baseName = path.basename(filename);
  if (baseName[0] === "." || baseName.indexOf(".") === -1) {
    return { type: "text/plain", compress: true };
  }

  // Everything else can be octet-stream compressed but print a warning
  // if we introduce a type we aren't specifically handling.
  if (!/\.(terrain|b3dm|geom|pnts|vctr|cmpt|i3dm|metadata)$/i.test(filename)) {
    console.log(`Unknown mime type for ${filename}`);
  }

  return { type: "application/octet-stream", compress: true };
}

// get all files currently in bucket asynchronously
function listAll(s3, bucketName, prefix, files, marker) {
  return s3
    .listObjects({
      Bucket: bucketName,
      MaxKeys: 1000,
      Prefix: prefix,
      Marker: marker,
    })
    .promise()
    .then(function (data) {
      const items = data.Contents;
      for (let i = 0; i < items.length; i++) {
        files.push(items[i].Key);
      }

      if (data.IsTruncated) {
        // get next page of results
        return listAll(s3, bucketName, prefix, files, files[files.length - 1]);
      }
    });
}

gulp.task("deploy-set-version", function (done) {
  const buildVersion = yargs.argv.buildVersion;
  if (buildVersion) {
    // NPM versions can only contain alphanumeric and hyphen characters
    packageJson.version += `-${buildVersion.replace(/[^[0-9A-Za-z-]/g, "")}`;
    fs.writeFileSync("package.json", JSON.stringify(packageJson, undefined, 2));
  }
  done();
});

gulp.task("deploy-status", function () {
  if (isTravisPullRequest()) {
    console.log("Skipping deployment status for non-pull request.");
    return Promise.resolve();
  }

  const status = yargs.argv.status;
  const message = yargs.argv.message;

  const deployUrl = `${travisDeployUrl + process.env.TRAVIS_BRANCH}/`;
  const zipUrl = `${deployUrl}Cesium-${packageJson.version}.zip`;
  const npmUrl = `${deployUrl}cesium-${packageJson.version}.tgz`;
  const coverageUrl = `${
    travisDeployUrl + process.env.TRAVIS_BRANCH
  }/Build/Coverage/index.html`;

  return Promise.join(
    setStatus(status, deployUrl, message, "deployment"),
    setStatus(status, zipUrl, message, "zip file"),
    setStatus(status, npmUrl, message, "npm package"),
    setStatus(status, coverageUrl, message, "coverage results")
  );
});

function setStatus(state, targetUrl, description, context) {
  // skip if the environment does not have the token
  if (!process.env.TOKEN) {
    return;
  }

  const requestPost = Promise.promisify(request.post);
  return requestPost({
    url: `https://api.github.com/repos/${process.env.TRAVIS_REPO_SLUG}/statuses/${process.env.TRAVIS_COMMIT}`,
    json: true,
    headers: {
      Authorization: `token ${process.env.TOKEN}`,
      "User-Agent": "Cesium",
    },
    body: {
      state: state,
      target_url: targetUrl,
      description: description,
      context: context,
    },
  });
}

gulp.task("coverage", async function () {
  const argv = yargs.argv;
  const webglStub = argv.webglStub ? argv.webglStub : false;
  const suppressPassed = argv.suppressPassed ? argv.suppressPassed : false;
  const failTaskOnError = argv.failTaskOnError ? argv.failTaskOnError : false;

  const folders = [];
  let browsers = ["Chrome"];
  if (argv.browsers) {
    browsers = argv.browsers.split(",");
  }

  const instrumenter = new istanbul.createInstrumenter({
    esModules: true,
  });

  const instrumentPlugin = {
    name: "instrument",
    setup: (build) => {
      const readFile = Promise.promisify(fs.readFile);
      build.onLoad(
        {
          filter: /Source\/(Core|DataSources|Renderer|Scene|Widgets)(\/\w+)+\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");

          try {
            const generatedCode = instrumenter.instrumentSync(
              source,
              args.path
            );

            return { contents: generatedCode };
          } catch (e) {
            return {
              errors: {
                text: e.message,
              },
            };
          }
        }
      );
    },
  };

  const outputDirectory = path.join("Build", "Instrumented");

  const result = await esbuild.build({
    entryPoints: ["Source/Cesium.js"],
    bundle: true,
    sourcemap: true,
    format: "iife",
    globalName: "Cesium",
    target: "es6",
    external: ["https", "http", "url", "zlib"],
    outfile: path.join(outputDirectory, "Cesium.js"),
    plugins: [instrumentPlugin],
    logLevel: "error", // print errors immediately, and collect warnings so we can filter out known ones
  });

  handleBuildWarnings(result);

  return new Promise((resolve, reject) => {
    const karma = new Karma.Server(
      {
        configFile: karmaConfigFile,
        browsers: browsers,
        specReporter: {
          suppressErrorSummary: false,
          suppressFailed: false,
          suppressPassed: suppressPassed,
          suppressSkipped: true,
        },
        files: [
          { pattern: "Specs/Data/**", included: false },
          { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
          { pattern: "Build/Instrumented/Cesium.js", included: true },
          { pattern: "Build/Instrumented/Cesium.js.map", included: false },
          { pattern: "Build/CesiumUnminified/**", included: false },
          {
            pattern: "Build/Specs/karma-main.js",
            included: true,
            type: "module",
          },
          {
            pattern: "Build/Specs/SpecList.js",
            included: true,
            type: "module",
          },
          { pattern: "Build/Specs/TestWorkers/**", included: false },
        ],
        reporters: ["spec", "coverage"],
        coverageReporter: {
          dir: "Build/Coverage",
          subdir: function (browserName) {
            folders.push(browserName);
            return browserName;
          },
          includeAllSources: true,
        },
        client: {
          captureConsole: false,
          args: [
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            webglStub,
            undefined,
          ],
        },
      },
      function (e) {
        let html = "<!doctype html><html><body><ul>";
        folders.forEach(function (folder) {
          html += `<li><a href="${encodeURIComponent(
            folder
          )}/index.html">${folder}</a></li>`;
        });
        html += "</ul></body></html>";
        fs.writeFileSync("Build/Coverage/index.html", html);

        if (!process.env.TRAVIS) {
          folders.forEach(function (dir) {
            open(`Build/Coverage/${dir}/index.html`);
          });
        }

        if (failTaskOnError && e) {
          reject(e);
          return;
        }

        resolve();
      }
    );
    karma.start();
  });
});

gulp.task("test", function (done) {
  const argv = yargs.argv;

  const enableAllBrowsers = argv.all ? true : false;
  const includeCategory = argv.include ? argv.include : "";
  const excludeCategory = argv.exclude ? argv.exclude : "";
  const webglValidation = argv.webglValidation ? argv.webglValidation : false;
  const webglStub = argv.webglStub ? argv.webglStub : false;
  const release = argv.release ? argv.release : false;
  const failTaskOnError = argv.failTaskOnError ? argv.failTaskOnError : false;
  const suppressPassed = argv.suppressPassed ? argv.suppressPassed : false;
  const debug = argv.debug ? false : true;
  const includeName = argv.includeName ? argv.includeName : "";

  let browsers = ["Chrome"];
  if (argv.browsers) {
    browsers = argv.browsers.split(",");
  }

  let files = [
    { pattern: "Specs/Data/**", included: false },
    { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
    { pattern: "Build/CesiumUnminified/Cesium.js", included: true },
    { pattern: "Build/CesiumUnminified/Cesium.js.map", included: false },
    { pattern: "Build/CesiumUnminified/**", included: false },
    { pattern: "Build/Specs/karma-main.js", included: true, type: "module" },
    { pattern: "Build/Specs/SpecList.js", included: true, type: "module" },
    { pattern: "Build/Specs/TestWorkers/**", included: false },
  ];

  if (release) {
    files = [
      { pattern: "Specs/Data/**", included: false },
      { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
      { pattern: "Specs/ThirdParty/**", included: false, type: "module" },
      { pattern: "Build/Cesium/Cesium.js", included: true },
      { pattern: "Build/Cesium/Cesium.js.map", included: false },
      { pattern: "Build/Cesium/**", included: false },
      { pattern: "Build/Specs/karma-main.js", included: true },
      { pattern: "Build/Specs/SpecList.js", included: true, type: "module" },
      { pattern: "Build/Specs/TestWorkers/**", included: false },
    ];
  }

  const karmaConfig = Karma.config.parseConfig(karmaConfigFile, {
    port: 9876,
    singleRun: debug,
    browsers: browsers,
    specReporter: {
      suppressErrorSummary: false,
      suppressFailed: false,
      suppressPassed: suppressPassed,
      suppressSkipped: true,
    },
    detectBrowsers: {
      enabled: enableAllBrowsers,
    },
    logLevel: verbose ? Karma.constants.LOG_INFO : Karma.constants.LOG_ERROR,
    files: files,
    client: {
      captureConsole: verbose,
      args: [
        includeCategory,
        excludeCategory,
        "--grep",
        includeName,
        webglValidation,
        webglStub,
        release,
      ],
    },
  });
  const karma = new Karma.Server(karmaConfig, function doneCallback(exitCode) {
    return done(failTaskOnError ? exitCode : undefined);
  });
  karma.start();
});

/**
 * Copies non-js assets to the output directory
 *
 * @param {Object} options
 * @param {String} options.outputDirectory
 * @returns
 */
function copyAssets(options) {
  const outputDirectory = options.outputDirectory;
  const everythingElse = [
    "Source/**",
    "!**/*.js",
    "!**/*.glsl",
    "!**/*.css",
    "!**/*.md",
  ];

  const stream = gulp
    .src(everythingElse, { nodir: true })
    .pipe(gulp.dest(outputDirectory));

  return streamToPromise(stream);
}

function glslToJavaScript(minify, minifyStateFilePath) {
  fs.writeFileSync(minifyStateFilePath, minify.toString());
  const minifyStateFileLastModified = fs.existsSync(minifyStateFilePath)
    ? fs.statSync(minifyStateFilePath).mtime.getTime()
    : 0;

  // collect all currently existing JS files into a set, later we will remove the ones
  // we still are using from the set, then delete any files remaining in the set.
  const leftOverJsFiles = {};

  globby
    .sync(["Source/Shaders/**/*.js", "Source/ThirdParty/Shaders/*.js"])
    .forEach(function (file) {
      leftOverJsFiles[path.normalize(file)] = true;
    });

  const builtinFunctions = [];
  const builtinConstants = [];
  const builtinStructs = [];

  const glslFiles = globby.sync(shaderFiles);
  glslFiles.forEach(function (glslFile) {
    glslFile = path.normalize(glslFile);
    const baseName = path.basename(glslFile, ".glsl");
    const jsFile = `${path.join(path.dirname(glslFile), baseName)}.js`;

    // identify built in functions, structs, and constants
    const baseDir = path.join("Source", "Shaders", "Builtin");
    if (
      glslFile.indexOf(path.normalize(path.join(baseDir, "Functions"))) === 0
    ) {
      builtinFunctions.push(baseName);
    } else if (
      glslFile.indexOf(path.normalize(path.join(baseDir, "Constants"))) === 0
    ) {
      builtinConstants.push(baseName);
    } else if (
      glslFile.indexOf(path.normalize(path.join(baseDir, "Structs"))) === 0
    ) {
      builtinStructs.push(baseName);
    }

    delete leftOverJsFiles[jsFile];

    const jsFileExists = fs.existsSync(jsFile);
    const jsFileModified = jsFileExists
      ? fs.statSync(jsFile).mtime.getTime()
      : 0;
    const glslFileModified = fs.statSync(glslFile).mtime.getTime();

    if (
      jsFileExists &&
      jsFileModified > glslFileModified &&
      jsFileModified > minifyStateFileLastModified
    ) {
      return;
    }

    let contents = fs.readFileSync(glslFile, "utf8");
    contents = contents.replace(/\r\n/gm, "\n");

    let copyrightComments = "";
    const extractedCopyrightComments = contents.match(
      /\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm
    );
    if (extractedCopyrightComments) {
      copyrightComments = `${extractedCopyrightComments.join("\n")}\n`;
    }

    if (minify) {
      contents = glslStripComments(contents);
      contents = contents
        .replace(/\s+$/gm, "")
        .replace(/^\s+/gm, "")
        .replace(/\n+/gm, "\n");
      contents += "\n";
    }

    contents = contents.split('"').join('\\"').replace(/\n/gm, "\\n\\\n");
    contents = `${copyrightComments}\
//This file is automatically rebuilt by the Cesium build process.\n\
export default "${contents}";\n`;

    fs.writeFileSync(jsFile, contents);
  });

  // delete any left over JS files from old shaders
  Object.keys(leftOverJsFiles).forEach(function (filepath) {
    rimraf.sync(filepath);
  });

  const generateBuiltinContents = function (contents, builtins, path) {
    for (let i = 0; i < builtins.length; i++) {
      const builtin = builtins[i];
      contents.imports.push(
        `import czm_${builtin} from './${path}/${builtin}.js'`
      );
      contents.builtinLookup.push(`czm_${builtin} : ` + `czm_${builtin}`);
    }
  };

  //generate the JS file for Built-in GLSL Functions, Structs, and Constants
  const contents = {
    imports: [],
    builtinLookup: [],
  };
  generateBuiltinContents(contents, builtinConstants, "Constants");
  generateBuiltinContents(contents, builtinStructs, "Structs");
  generateBuiltinContents(contents, builtinFunctions, "Functions");

  const fileContents = `//This file is automatically rebuilt by the Cesium build process.\n${contents.imports.join(
    "\n"
  )}\n\nexport default {\n    ${contents.builtinLookup.join(",\n    ")}\n};\n`;

  fs.writeFileSync(
    path.join("Source", "Shaders", "Builtin", "CzmBuiltins.js"),
    fileContents
  );
}

function createCesiumJs() {
  let contents = `export const VERSION = '${version}';\n`;
  globby.sync(sourceFiles).forEach(function (file) {
    file = path.relative("Source", file);

    let moduleId = file;
    moduleId = filePathToModuleId(moduleId);

    let assignmentName = path.basename(file, path.extname(file));
    if (moduleId.indexOf("Shaders/") === 0) {
      assignmentName = `_shaders${assignmentName}`;
    }
    assignmentName = assignmentName.replace(/(\.|-)/g, "_");
    contents += `export { default as ${assignmentName} } from './${moduleId}.js';${os.EOL}`;
  });

  fs.writeFileSync("Source/Cesium.js", contents);
}

function createTypeScriptDefinitions() {
  // Run jsdoc with tsd-jsdoc to generate an initial Cesium.d.ts file.
  child_process.execSync("npx jsdoc --configure Tools/jsdoc/ts-conf.json", {
    stdio: "inherit",
  });

  let source = fs.readFileSync("Source/Cesium.d.ts").toString();

  // All of our enum assignments that alias to WebGLConstants, such as PixelDatatype.js
  // end up as enum strings instead of actually mapping values to WebGLConstants.
  // We fix this with a simple regex replace later on, but it means the
  // WebGLConstants constants enum needs to be defined in the file before it can
  // be used.  This block of code reads in the TS file, finds the WebGLConstants
  // declaration, and then writes the file back out (in memory to source) with
  // WebGLConstants being the first module.
  const node = typescript.createSourceFile(
    "Source/Cesium.d.ts",
    source,
    typescript.ScriptTarget.Latest
  );
  let firstNode;
  node.forEachChild((child) => {
    if (
      typescript.SyntaxKind[child.kind] === "EnumDeclaration" &&
      child.name.escapedText === "WebGLConstants"
    ) {
      firstNode = child;
    }
  });

  const printer = typescript.createPrinter({
    removeComments: false,
    newLine: typescript.NewLineKind.LineFeed,
  });

  let newSource = "";
  newSource += printer.printNode(
    typescript.EmitHint.Unspecified,
    firstNode,
    node
  );
  newSource += "\n\n";
  node.forEachChild((child) => {
    if (
      typescript.SyntaxKind[child.kind] !== "EnumDeclaration" ||
      child.name.escapedText !== "WebGLConstants"
    ) {
      newSource += printer.printNode(
        typescript.EmitHint.Unspecified,
        child,
        node
      );
      newSource += "\n\n";
    }
  });
  source = newSource;

  // The next step is to find the list of Cesium modules exported by the Cesium API
  // So that we can map these modules with a link back to their original source file.

  const regex = /^declare (function|class|namespace|enum) (.+)/gm;
  let matches;
  const publicModules = new Set();
  //eslint-disable-next-line no-cond-assign
  while ((matches = regex.exec(source))) {
    const moduleName = matches[2].match(/([^<\s|\(]+)/);
    publicModules.add(moduleName[1]);
  }

  // Math shows up as "Math" because of it's aliasing from CesiumMath and namespace collision with actual Math
  // It fails the above regex so just add it directly here.
  publicModules.add("Math");

  // Fix up the output to match what we need
  // declare => export since we are wrapping everything in a namespace
  // CesiumMath => Math (because no CesiumJS build step would be complete without special logic for the Math class)
  // Fix up the WebGLConstants aliasing we mentioned above by simply unquoting the strings.
  source = source
    .replace(/^declare /gm, "export ")
    .replace(/module "Math"/gm, "namespace Math")
    .replace(/CesiumMath/gm, "Math")
    .replace(/Number\[]/gm, "number[]") // Workaround https://github.com/englercj/tsd-jsdoc/issues/117
    .replace(/String\[]/gm, "string[]")
    .replace(/Boolean\[]/gm, "boolean[]")
    .replace(/Object\[]/gm, "object[]")
    .replace(/<Number>/gm, "<number>")
    .replace(/<String>/gm, "<string>")
    .replace(/<Boolean>/gm, "<boolean>")
    .replace(/<Object>/gm, "<object>")
    .replace(
      /= "WebGLConstants\.(.+)"/gm,
      // eslint-disable-next-line no-unused-vars
      (match, p1) => `= WebGLConstants.${p1}`
    )
    // Strip const enums which can cause errors - https://www.typescriptlang.org/docs/handbook/enums.html#const-enum-pitfalls
    .replace(/^(\s*)(export )?const enum (\S+) {(\s*)$/gm, "$1$2enum $3 {$4");

  // Wrap the source to actually be inside of a declared cesium module
  // and add any workaround and private utility types.
  source = `declare module "cesium" {
${source}
}

`;

  // Map individual modules back to their source file so that TS still works
  // when importing individual files instead of the entire cesium module.
  globby.sync(sourceFiles).forEach(function (file) {
    file = path.relative("Source", file);

    let moduleId = file;
    moduleId = filePathToModuleId(moduleId);

    const assignmentName = path.basename(file, path.extname(file));
    if (publicModules.has(assignmentName)) {
      publicModules.delete(assignmentName);
      source += `declare module "cesium/Source/${moduleId}" { import { ${assignmentName} } from 'cesium'; export default ${assignmentName}; }\n`;
    }
  });

  // Write the final source file back out
  fs.writeFileSync("Source/Cesium.d.ts", source);

  // Use tsc to compile it and make sure it is valid
  child_process.execSync("npx tsc -p Tools/jsdoc/tsconfig.json", {
    stdio: "inherit",
  });

  // Also compile our smokescreen to make sure interfaces work as expected.
  child_process.execSync("npx tsc -p Specs/TypeScript/tsconfig.json", {
    stdio: "inherit",
  });

  // Below is a sanity check to make sure we didn't leave anything out that
  // we don't already know about

  // Intentionally ignored nested items
  publicModules.delete("KmlFeatureData");
  publicModules.delete("MaterialAppearance");

  if (publicModules.size !== 0) {
    throw new Error(
      `Unexpected unexposed modules: ${Array.from(publicModules.values()).join(
        ", "
      )}`
    );
  }
}

function createSpecList() {
  const files = globby.sync(["Specs/**/*Spec.js"]);

  let contents = "";
  files.forEach(function (file) {
    contents += `import './${filePathToModuleId(file).replace(
      "Specs/",
      ""
    )}.js';\n`;
  });

  fs.writeFileSync(path.join("Specs", "SpecList.js"), contents);
}

/**
 * Reads `ThirdParty.extra.json` file
 * @param path {string} Path to `ThirdParty.extra.json`
 * @param discoveredDependencies {Array<string>} List of previously discovered modules
 * @returns {Promise<Array<Object>>} A promise to an array of objects with 'name`, `license`, and `url` strings
 */
function getLicenseDataFromThirdPartyExtra(path, discoveredDependencies) {
  if (!fs.existsSync(path)) {
    return Promise.reject(`${path} does not exist`);
  }

  const fsReadFile = Promise.promisify(fs.readFile);

  return fsReadFile(path).then(function (contents) {
    const thirdPartyExtra = JSON.parse(contents);
    return Promise.map(thirdPartyExtra, function (module) {
      if (!discoveredDependencies.includes(module.name)) {
        // If this is not a npm module, return existing info
        if (!packageJson.devDependencies[module.name]) {
          discoveredDependencies.push(module.name);
          return Promise.resolve(module);
        }

        return getLicenseDataFromPackage(
          module.name,
          discoveredDependencies,
          module.license,
          module.notes
        );
      }
    });
  });
}

/**
 * Extracts name, license, and url from `package.json` file.
 *
 * @param packageName {string} Name of package
 * @param discoveredDependencies {Array<string>} List of previously discovered modules
 * @param licenseOverride {Array<string>} If specified, override info fetched from package.json. Useful in the case where there are multiple licenses and we might chose a single one.
 * @returns {Promise<Object>} A promise to an object with 'name`, `license`, and `url` strings
 */
function getLicenseDataFromPackage(
  packageName,
  discoveredDependencies,
  licenseOverride,
  notes
) {
  if (discoveredDependencies.includes(packageName)) {
    return Promise.resolve([]);
  }
  discoveredDependencies.push(packageName);

  let promise;
  const packagePath = path.join("node_modules", packageName, "package.json");
  const fsReadFile = Promise.promisify(fs.readFile);

  if (fs.existsSync(packagePath)) {
    // Package exists at top-level, so use it.
    promise = fsReadFile(packagePath);
  } else {
    return Promise.reject(
      new Error(`Unable to find ${packageName} license information`)
    );
  }

  return promise.then(function (contents) {
    const packageJson = JSON.parse(contents);

    // Check for license
    let licenseField = licenseOverride;

    if (!licenseField) {
      licenseField = [packageJson.license];
    }

    if (!licenseField && packageJson.licenses) {
      licenseField = packageJson.licenses;
    }

    if (!licenseField) {
      console.log(`No license found for ${packageName}`);
      licenseField = ["NONE"];
    }

    let version = packageJson.version;
    if (!packageJson.version) {
      console.log(`No version information found for ${packageName}`);
      version = "NONE";
    }

    return {
      name: packageName,
      license: licenseField,
      version: version,
      url: `https://www.npmjs.com/package/${packageName}`,
      notes: notes,
    };
  });
}

function generateThirdParty() {
  let licenseJson = [];
  const discoveredDependencies = [];
  const fsWriteFile = Promise.promisify(fs.writeFile);

  // Generate ThirdParty.json from ThirdParty.extra.json and package.json
  return getLicenseDataFromThirdPartyExtra(
    "ThirdParty.extra.json",
    discoveredDependencies
  )
    .then(function (licenseInfo) {
      licenseJson = licenseJson.concat(licenseInfo);
    })
    .then(function () {
      licenseJson.sort(function (a, b) {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        if (nameA < nameB) {
          return -1;
        }
        if (nameA > nameB) {
          return 1;
        }
        return 0;
      });

      return fsWriteFile(
        "ThirdParty.json",
        JSON.stringify(licenseJson, null, 2)
      );
    });
}

function createGalleryList() {
  const demoObjects = [];
  const demoJSONs = [];
  const output = path.join("Apps", "Sandcastle", "gallery", "gallery-index.js");

  const fileList = ["Apps/Sandcastle/gallery/**/*.html"];
  if (noDevelopmentGallery) {
    fileList.push("!Apps/Sandcastle/gallery/development/**/*.html");
  }

  // On travis, the version is set to something like '1.43.0-branch-name-travisBuildNumber'
  // We need to extract just the Major.Minor version
  const majorMinor = packageJson.version.match(/^(.*)\.(.*)\./);
  const major = majorMinor[1];
  const minor = Number(majorMinor[2]) - 1; // We want the last release, not current release
  const tagVersion = `${major}.${minor}`;

  // Get an array of demos that were added since the last release.
  // This includes newly staged local demos as well.
  let newDemos = [];
  try {
    newDemos = child_process
      .execSync(
        `git diff --name-only --diff-filter=A ${tagVersion} Apps/Sandcastle/gallery/*.html`,
        { stdio: ["pipe", "pipe", "ignore"] }
      )
      .toString()
      .trim()
      .split("\n");
  } catch (e) {
    // On a Cesium fork, tags don't exist so we can't generate the list.
  }

  let helloWorld;
  globby.sync(fileList).forEach(function (file) {
    const demo = filePathToModuleId(
      path.relative("Apps/Sandcastle/gallery", file)
    );

    const demoObject = {
      name: demo,
      isNew: newDemos.includes(file),
    };

    if (fs.existsSync(`${file.replace(".html", "")}.jpg`)) {
      demoObject.img = `${demo}.jpg`;
    }

    demoObjects.push(demoObject);

    if (demo === "Hello World") {
      helloWorld = demoObject;
    }
  });

  demoObjects.sort(function (a, b) {
    if (a.name < b.name) {
      return -1;
    } else if (a.name > b.name) {
      return 1;
    }
    return 0;
  });

  const helloWorldIndex = Math.max(demoObjects.indexOf(helloWorld), 0);

  for (let i = 0; i < demoObjects.length; ++i) {
    demoJSONs[i] = JSON.stringify(demoObjects[i], null, 2);
  }

  const contents = `\
// This file is automatically rebuilt by the Cesium build process.\n\
const hello_world_index = ${helloWorldIndex};\n\
const VERSION = '${version}';\n\
const gallery_demos = [${demoJSONs.join(", ")}];\n\
const has_new_gallery_demos = ${newDemos.length > 0 ? "true;" : "false;"}\n`;

  fs.writeFileSync(output, contents);

  // Compile CSS for Sandcastle
  return streamToPromise(
    gulp
      .src(path.join("Apps", "Sandcastle", "templates", "bucketRaw.css"))
      .pipe(cleanCSS())
      .pipe(gulpRename("bucket.css"))
      .pipe(
        gulpInsert.prepend(
          "/* This file is automatically rebuilt by the Cesium build process. */\n"
        )
      )
      .pipe(gulp.dest(path.join("Apps", "Sandcastle", "templates")))
  );
}

function createJsHintOptions() {
  const jshintrc = JSON.parse(
    fs.readFileSync(path.join("Apps", "Sandcastle", ".jshintrc"), "utf8")
  );

  const contents = `\
// This file is automatically rebuilt by the Cesium build process.\n\
const sandcastleJsHintOptions = ${JSON.stringify(jshintrc, null, 4)};\n`;

  fs.writeFileSync(
    path.join("Apps", "Sandcastle", "jsHintOptions.js"),
    contents
  );
}

function buildSandcastle() {
  const appStream = gulp
    .src([
      "Apps/Sandcastle/**",
      "!Apps/Sandcastle/load-cesium-es6.js",
      "!Apps/Sandcastle/standalone.html",
      "!Apps/Sandcastle/images/**",
      "!Apps/Sandcastle/gallery/**.jpg",
    ])
    // Remove swap out ESM modules for the IIFE build
    .pipe(
      gulpReplace(
        '    <script type="module" src="../load-cesium-es6.js"></script>',
        '    <script src="../../../Build/CesiumUnminified/Cesium.js"></script>\n' +
          '    <script>window.CESIUM_BASE_URL = "../../../Build/CesiumUnminified/";</script>";'
      )
    )
    // Fix relative paths for new location
    .pipe(gulpReplace("../../../Build", "../../.."))
    .pipe(gulpReplace("../../Source", "../../../Source"))
    .pipe(gulpReplace("../../ThirdParty", "../../../ThirdParty"))
    .pipe(gulpReplace("../../SampleData", "../../../../Apps/SampleData"))
    .pipe(gulpReplace("Build/Documentation", "Documentation"))
    .pipe(gulp.dest("Build/Apps/Sandcastle"));

  const imageStream = gulp
    .src(["Apps/Sandcastle/gallery/**.jpg", "Apps/Sandcastle/images/**"], {
      base: "Apps/Sandcastle",
      buffer: false,
    })
    .pipe(gulp.dest("Build/Apps/Sandcastle"));

  const standaloneStream = gulp
    .src(["Apps/Sandcastle/standalone.html"])
    .pipe(
      gulpReplace(
        '    <script type="module" src="load-cesium-es6.js"></script>',
        '    <script src="../../Build/CesiumUnminified/Cesium.js"></script>\n' +
          '    <script>window.CESIUM_BASE_URL = "../../Build/CesiumUnminified/";</script>";'
      )
    )
    .pipe(gulpReplace("../../Build", "../.."))
    .pipe(gulp.dest("Build/Apps/Sandcastle"));

  return streamToPromise(mergeStream(appStream, imageStream, standaloneStream));
}

async function buildCesiumViewer() {
  const cesiumViewerOutputDirectory = "Build/Apps/CesiumViewer";
  mkdirp.sync(cesiumViewerOutputDirectory);

  const result = await esbuild.build({
    ...esbuildBaseConfig,
    entryPoints: [
      "Apps/CesiumViewer/CesiumViewer.js",
      "Apps/CesiumViewer/CesiumViewer.css",
    ],
    bundle: true, // Tree-shaking is enabled automatically
    minify: true,
    loader: {
      ".gif": "text",
      ".png": "text",
    },
    format: "iife",
    inject: ["Apps/CesiumViewer/index.js"],
    external: ["https", "http", "zlib"],
    plugins: [stripPragmaPlugin],
    outdir: cesiumViewerOutputDirectory,
    outbase: "Apps/CesiumViewer",
    logLevel: "error", // print errors immediately, and collect warnings so we can filter out known ones
  });

  handleBuildWarnings(result);

  await esbuild.build({
    entryPoints: ["Source/Widgets/InfoBox/InfoBoxDescription.css"],
    minify: true,
    bundle: true,
    loader: {
      ".gif": "text",
      ".png": "text",
    },
    outdir: cesiumViewerOutputDirectory,
    outbase: "Source",
  });

  await createWorkers({
    minify: true,
    path: cesiumViewerOutputDirectory,
  });

  const stream = mergeStream(
    gulp.src([
      "Apps/CesiumViewer/**",
      "!Apps/CesiumViewer/Images",
      "!Apps/CesiumViewer/**/*.js",
      "!Apps/CesiumViewer/**/*.css",
    ]),

    gulp.src(
      [
        "Build/Cesium/Assets/**",
        "Build/Cesium/Workers/**",
        "Build/Cesium/ThirdParty/**",
        "Build/Cesium/Widgets/**",
        "!Build/Cesium/Widgets/**/*.css",
      ],
      {
        base: "Build/Cesium",
        nodir: true,
      }
    ),

    gulp.src(["web.config"])
  );

  return streamToPromise(stream.pipe(gulp.dest(cesiumViewerOutputDirectory)));
}

function filePathToModuleId(moduleId) {
  return moduleId.substring(0, moduleId.lastIndexOf(".")).replace(/\\/g, "/");
}
