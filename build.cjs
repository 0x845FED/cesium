/*eslint-env node*/
"use strict";

const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const esbuild = require("esbuild");
const globby = require("globby");
const glslStripComments = require("glsl-strip-comments");
const gulp = require("gulp");
const rimraf = require("rimraf");
const rollup = require("rollup");
const rollupPluginStripPragma = require("rollup-plugin-strip-pragma");
const rollupPluginTerser = require("rollup-plugin-terser");
const rollupCommonjs = require("@rollup/plugin-commonjs");
const rollupResolve = require("@rollup/plugin-node-resolve").default;
const streamToPromise = require("stream-to-promise");

const packageJson = require("./package.json");
let version = packageJson.version;
if (/\.0$/.test(version)) {
  version = version.substring(0, version.length - 2);
}

let copyrightHeader = fs.readFileSync(
  path.join("Source", "copyrightHeader.js"),
  "utf8"
);
copyrightHeader = copyrightHeader.replace("${version}", version);

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

const cssFiles = "Source/**/*.css";
const esbuildBaseConfig = {
  target: "es2020",
  legalComments: "inline",
  banner: {
    js: copyrightHeader,
  },
};

/**
 * Bundles all individual modules, optionally minifying and stripping out debug pragmas.
 * @param {Object} options
 * @param {String} options.path Directory where build artifacts are output
 * @param {Boolean} [options.minify=false] true if the output should be minified
 * @param {Boolean} [options.removePragmas=false] true if the output should have debug pragmas stripped out
 * @param {Boolean} [options.sourcemaps=false] true if an external sourcemap should be generated
 * @param {Boolean} [options.iife=false] true if an IIFE style module should be built
 * @param {Boolean} [options.node=false] true if a CJS style node module should be built
 * @param {Boolean} [options.incremental=false] true if build output should be cached for repeated builds
 * @returns
 */
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

function filePathToModuleId(moduleId) {
  return moduleId.substring(0, moduleId.lastIndexOf(".")).replace(/\\/g, "/");
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

/**
 * Creates a single entry point file, Cesium.js, which imports all individual modules exported from the Cesium API.
 */
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

/**
 * Creates a single entry point file, SpecList.js, which imports all individual spec files.
 */
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

function rollupWarning(message) {
  // Ignore eval warnings in third-party code we don't have control over
  if (message.code === "EVAL" && /protobufjs/.test(message.loc.file)) {
    return;
  }

  console.log(message);
}

/**
 * Bundles the workers and outputs the result to the specified directory
 * @param {Object} options
 * @param {boolean} [options.minify=false] true if the worker output should be minified
 * @param {boolean} [options.removePragmas=false] true if debug pragma should be removed
 * @param {boolean} [options.sourcemap=false] true if an external sourcemap should be generated
 * @param {String} options.path output directory
 */
async function buildWorkers(options) {
  // Copy existing workers
  const workers = globby.sync([
    "Source/Workers/**",
    "Source/ThirdParty/Workers/**",
  ]);

  await esbuild.build({
    ...esbuildBaseConfig,
    entryPoints: workers,
    outdir: options.path,
    outbase: "Source", // Maintain existing file paths
    minify: options.minify,
  });

  // Use rollup to build the workers:
  // 1) They can be built as AMD style modules
  // 2) They can be built using code-splitting, resulting in smaller modules
  return globby(["Source/WorkersES6/*.js"]).then(function (files) {
    const plugins = [rollupResolve(), rollupCommonjs()];

    if (options.removePragmas) {
      plugins.push(
        rollupPluginStripPragma({
          pragmas: ["debug"],
        })
      );
    }

    if (options.minify) {
      plugins.push(rollupPluginTerser.terser());
    }

    return rollup
      .rollup({
        input: files,
        plugins: plugins,
        onwarn: rollupWarning,
      })
      .then(function (bundle) {
        return bundle.write({
          dir: path.join(options.path, "Workers"),
          format: "amd",
          // Rollup cannot generate a sourcemap
          sourcemap: options.sourcemap && !options.removePragmas,
          banner: copyrightHeader,
        });
      });
  });
}

const shaderFiles = [
  "Source/Shaders/**/*.glsl",
  "Source/ThirdParty/Shaders/*.glsl",
];
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

/**
   * Creates a template html file in the Sandcastle app listing the gallery of demos
   * @param {Boolean} [noDevelopmentGallery=false] true if the development gallery should not be included in the list
   * @returns {Promise.<*>}
   */
 function createGalleryList(noDevelopmentGallery) {
  const demoObjects = [];
  const demoJSONs = [];
  const output = path.join(
    "Apps",
    "Sandcastle",
    "gallery",
    "gallery-index.js"
  );

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
  return esbuild.build({
    entryPoints: [
      path.join("Apps", "Sandcastle", "templates", "bucketRaw.css"),
    ],
    minify: true,
    banner: {
      css:
        "/* This file is automatically rebuilt by the Cesium build process. */\n",
    },
    outfile: path.join("Apps", "Sandcastle", "templates", "bucket.css"),
  });
};

module.exports = {
  esbuildBaseConfig,
  createCesiumJs,
  buildCesiumJs,
  buildWorkers,
  glslToJavaScript,
  createSpecList,
  buildSpecs: async (options) => {
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
      target: "es2020",
      outdir: path.join("Build", "Specs"),
      plugins: [externalResolvePlugin],
      incremental: options.incremental,
    });

    return results;
  },
  /**
 * Copies non-js assets to the output directory
 *
 * @param {String} outputDirectory
 * @returns Promise.<*>
 */
copyAssets: (outputDirectory) => {
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
},
  createJsHintOptions: () => {
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
  },
  createGalleryList
};
