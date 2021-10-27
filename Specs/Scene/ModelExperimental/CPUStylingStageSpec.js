import {
  clone,
  ColorBlendMode,
  CPUStylingStage,
  ModelAlphaOptions,
  Pass,
  ShaderBuilder,
  StyleCommandsNeeded,
  _shadersCPUStylingStageFS,
  _shadersCPUStylingStageVS,
} from "../../../Source/Cesium.js";
import ShaderBuilderTester from "../../ShaderBuilderTester.js";

describe("Scene/ModelExperimental/CPUStylingStage", function () {
  var defaultRenderResources = {
    alphaOptions: new ModelAlphaOptions(),
    model: {
      colorBlendMode: ColorBlendMode.HIGHLIGHT,
      colorBlendAmount: 0.5,
      featureTableId: 0,
      featureTables: [
        {
          featuresLength: 10,
          batchTexture: {
            translucentFeaturesLength: 0,
          },
        },
      ],
    },
    shaderBuilder: new ShaderBuilder(),
    uniformMap: {},
  };

  it("adds shader functions and defines", function () {
    var renderResources = clone(defaultRenderResources, true);
    var shaderBuilder = renderResources.shaderBuilder;

    CPUStylingStage.process(renderResources);

    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "USE_CPU_STYLING",
    ]);
    ShaderBuilderTester.expectFragmentLinesEqual(shaderBuilder, [
      _shadersCPUStylingStageFS,
    ]);
    ShaderBuilderTester.expectVertexLinesEqual(shaderBuilder, [
      _shadersCPUStylingStageVS,
    ]);
  });

  it("adds color blend uniform", function () {
    var renderResources = clone(defaultRenderResources, true);
    renderResources.model.colorBlendAmount = 0.75;
    renderResources.model.colorBlendMode = ColorBlendMode.MIX;
    var colorBlend = ColorBlendMode.getColorBlend(
      renderResources.model.colorBlendMode,
      renderResources.model.colorBlendAmount
    );

    CPUStylingStage.process(renderResources);

    var shaderBuilder = renderResources.shaderBuilder;
    var uniformMap = renderResources.uniformMap;

    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform bool model_commandTranslucent;",
      "uniform float model_colorBlend;",
    ]);

    expect(uniformMap.model_colorBlend()).toEqual(colorBlend);
  });

  it("adds command translucent uniform", function () {
    var renderResources = clone(defaultRenderResources, true);
    renderResources.alphaOptions.pass = Pass.TRANSLUCENT;

    CPUStylingStage.process(renderResources);

    var shaderBuilder = renderResources.shaderBuilder;
    var uniformMap = renderResources.uniformMap;

    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform bool model_commandTranslucent;",
      "uniform float model_colorBlend;",
    ]);

    expect(uniformMap.model_commandTranslucent()).toEqual(true);
  });

  it("sets the style commands needed when only opaque commands are needed", function () {
    var renderResources = clone(defaultRenderResources, true);
    var batchTexture = {
      translucentFeaturesLength: 0,
      featuresLength: 10,
    };
    renderResources.model.featureTables[0].batchTexture = batchTexture;

    CPUStylingStage.process(renderResources);

    expect(renderResources.styleCommandsNeeded).toEqual(
      StyleCommandsNeeded.ALL_OPAQUE
    );
  });

  it("sets the style commands needed when only translucent commands are needed", function () {
    var renderResources = clone(defaultRenderResources, true);
    var batchTexture = {
      translucentFeaturesLength: 10,
    };
    renderResources.model.featureTables[0].batchTexture = batchTexture;

    CPUStylingStage.process(renderResources);

    expect(renderResources.styleCommandsNeeded).toEqual(
      StyleCommandsNeeded.ALL_TRANSLUCENT
    );
  });

  it("sets the style commands needed when both opaque and translucent commands are needed", function () {
    var renderResources = clone(defaultRenderResources, true);
    var batchTexture = {
      translucentFeaturesLength: 5,
    };
    renderResources.model.featureTables[0].batchTexture = batchTexture;

    CPUStylingStage.process(renderResources);

    expect(renderResources.styleCommandsNeeded).toEqual(
      StyleCommandsNeeded.OPAQUE_AND_TRANSLUCENT
    );
  });
});
