import Cartesian3 from "../../Core/Cartesian3.js";
import Cartesian4 from "../../Core/Cartesian4.js";
import CesiumMath from "../../Core/Math.js";
import Cesium3DTileRefine from "../Cesium3DTileRefine.js";
import clone from "../../Core/clone.js";
import combine from "../../Core/combine.js";
import defaultValue from "../../Core/defaultValue.js";
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import ModelExperimentalType from "./ModelExperimentalType.js";
import ModelExperimentalUtility from "./ModelExperimentalUtility.js";
import OrthographicFrustum from "../../Core/OrthographicFrustum.js";
import PointCloudCPUStylingStageVS from "../../Shaders/ModelExperimental/PointCloudCPUStylingStageVS.js";
import RuntimeError from "../../Core/RuntimeError.js";
import SceneMode from "../SceneMode.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import VertexAttributeSemantic from "../VertexAttributeSemantic.js";

const scratchUniform = new Cartesian4();

/**
 * The point cloud CPU styling stage is responsible for applying color,
 * size, and show styles to point clouds at runtime. It also handles
 * point cloud shading provided by either the model or the tileset that
 * owns it, which is used if no style is provided.
 *
 * @namespace PointCloudStylingPipelineStage
 *
 * @private
 */
const PointCloudStylingPipelineStage = {};
PointCloudStylingPipelineStage.name = "PointCloudStylingPipelineStage"; // Helps with debugging

/**
 * Processes a primitive. This modifies the following parts of the render resources:
 * <ul>
 *  <li>adds vertex shader code to compute attenuation and update gl_PointSize</li>
 *  <li>updates the uniform map to pass in point cloud parameters</li>
 *  <li>adds the styling code to both the vertex and fragment shaders</li>
 *  <li>adds the define to trigger the stage's shader functions</li>
 * </ul>
 *
 * @param {PrimitiveRenderResources} renderResources The render resources for this primitive.
 * @param {ModelComponents.Primitive} primitive The primitive.
 * @param {FrameState} frameState The frame state.
 *
 * @private
 */
PointCloudStylingPipelineStage.process = function (
  renderResources,
  primitive,
  frameState
) {
  const shaderBuilder = renderResources.shaderBuilder;
  const model = renderResources.model;
  const pointCloudShading = model.pointCloudShading;

  shaderBuilder.addDefine(
    "HAS_POINT_CLOUD_STYLING",
    undefined,
    ShaderDestination.VERTEX
  );

  const shaderFunctionInfo = getStyleShaderFunctionInfo(model.style);
  addShaderFunctionsAndDefines(shaderBuilder, shaderFunctionInfo);

  const propertyNames = getPropertyNames(shaderFunctionInfo);

  const usesNormalSemantic = propertyNames.indexOf("NORMAL") >= 0;
  const hasNormals = ModelExperimentalUtility.getAttributeBySemantic(
    primitive,
    VertexAttributeSemantic.NORMAL
  );

  if (usesNormalSemantic && !hasNormals) {
    throw new RuntimeError(
      "Style references the NORMAL semantic but the point cloud does not have normals"
    );
  }

  let content;
  let is3DTiles;
  let usesAddRefinement;

  if (ModelExperimentalType.is3DTiles(model.type)) {
    is3DTiles = true;
    content = model.content;
    usesAddRefinement = content.tile.refine === Cesium3DTileRefine.ADD;
  }

  shaderBuilder.addUniform(
    "vec4",
    "model_pointCloudAttenuation",
    ShaderDestination.VERTEX
  );

  shaderBuilder.addVertexLines([PointCloudCPUStylingStageVS]);

  const uniformMap = {};

  uniformMap.model_pointCloudAttenuation = function () {
    const vec4 = scratchUniform;

    // Point size
    let defaultPointSize = 1.0;
    if (is3DTiles) {
      defaultPointSize = usesAddRefinement
        ? 5.0
        : content.tileset.maximumScreenSpaceError;
    }
    vec4.x = defaultValue(
      pointCloudShading.maximumAttenuation,
      defaultPointSize
    );
    vec4.x *= frameState.pixelRatio;

    // Time
    vec4.y = content.tileset.timeSinceLoad;

    // Geometric error
    const geometricError = getGeometricError(
      renderResources,
      primitive,
      pointCloudShading,
      content
    );
    vec4.z = geometricError * pointCloudShading.geometricErrorScale;

    const context = frameState.context;
    const frustum = frameState.camera.frustum;
    let depthMultiplier;

    // Attenuation is maximumAttenuation in 2D/ortho
    if (
      frameState.mode === SceneMode.SCENE2D ||
      frustum instanceof OrthographicFrustum
    ) {
      depthMultiplier = Number.POSITIVE_INFINITY;
    } else {
      depthMultiplier =
        context.drawingBufferHeight / frameState.camera.frustum.sseDenominator;
    }

    // Depth multiplier
    vec4.w = depthMultiplier;

    return vec4;
  };

  renderResources.uniformMap = combine(uniformMap, renderResources.uniformMap);
};

const scratchDimensions = new Cartesian3();
function getGeometricError(
  renderResources,
  primitive,
  pointCloudShading,
  content
) {
  if (defined(content)) {
    const geometricError = content.tile.geometricError;

    if (geometricError > 0) {
      return geometricError;
    }
  }

  if (defined(pointCloudShading.baseResolution)) {
    return pointCloudShading.baseResolution;
  }

  const positionAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    primitive,
    VertexAttributeSemantic.POSITION
  );
  const pointsLength = positionAttribute.count;

  // Estimate the geometric error
  const nodeTransform = renderResources.runtimeNode.transform;
  let dimensions = Cartesian3.subtract(
    positionAttribute.max,
    positionAttribute.min,
    scratchDimensions
  );
  // dimensions is a vector, as it is a subtraction between two points
  dimensions = Matrix4.multiplyByPointAsVector(
    nodeTransform,
    dimensions,
    scratchDimensions
  );
  const volume = dimensions.x * dimensions.y * dimensions.z;
  const geometricErrorEstimate = CesiumMath.cbrt(volume / pointsLength);
  return geometricErrorEstimate;
}

const scratchShaderFunctionInfo = {
  colorStyleFunction: undefined,
  showStyleFunction: undefined,
  pointSizeStyleFunction: undefined,
  styleTranslucent: false,
};

const builtinVariableSubstitutionMap = {
  POSITION: "attributes.positionMC",
  POSITION_ABSOLUTE: "v_positionWC",
  COLOR: "attributes.color_0",
  NORMAL: "attributes.normalMC",
};

const parameterList = "ProcessedAttributes attributes";

function getStyleShaderFunctionInfo(style) {
  const info = scratchShaderFunctionInfo;
  const variableSubstitutionMap = clone(builtinVariableSubstitutionMap);
  const shaderState = {
    translucent: false,
  };

  info.colorStyleFunction = style.getColorShaderFunction(
    `getColorFromStyle(${parameterList})`,
    variableSubstitutionMap,
    shaderState
  );
  info.showStyleFunction = style.getShowShaderFunction(
    `getShowFromStyle(${parameterList})`,
    variableSubstitutionMap,
    shaderState
  );
  info.pointSizeStyleFunction = style.getPointSizeShaderFunction(
    `getPointSizeFromStyle(${parameterList})`,
    variableSubstitutionMap,
    shaderState
  );
  info.styleTranslucent =
    defined(info.colorStyleFunction) && shaderState.translucent;

  return info;
}

function addShaderFunctionsAndDefines(shaderBuilder, shaderFunctionInfo) {
  const colorStyleFunction = shaderFunctionInfo.colorStyleFunction;
  if (defined(colorStyleFunction)) {
    shaderBuilder.addDefine(
      "HAS_POINT_CLOUD_COLOR_STYLE",
      undefined,
      ShaderDestination.VERTEX
    );
    shaderBuilder.addVertexLines([colorStyleFunction]);
  }

  const showStyleFunction = shaderFunctionInfo.showStyleFunction;
  if (defined(shaderFunctionInfo.showStyleFunction)) {
    shaderBuilder.addDefine(
      "HAS_POINT_CLOUD_SHOW_STYLE",
      undefined,
      ShaderDestination.VERTEX
    );
    shaderBuilder.addVertexLines([showStyleFunction]);
  }

  const pointSizeStyleFunction = shaderFunctionInfo.pointSizeStyleFunction;
  if (defined(pointSizeStyleFunction)) {
    shaderBuilder.addDefine(
      "HAS_POINT_CLOUD_POINT_SIZE_STYLE",
      undefined,
      ShaderDestination.VERTEX
    );
    shaderBuilder.addVertexLines([pointSizeStyleFunction]);
  }
}

/**
 * Gets all the built-in property names used by the given style
 * function, ignoring the function signature.
 *
 * @param {Function} source The style function.
 * @param {String[]} propertyNames The array of property names to add to.
 *
 * @private
 */
function getBuiltinPropertyNames(source, propertyNames) {
  source = source.slice(source.indexOf("\n"));
  const regex = /czm_3dtiles_builtin_property_(\w+)/g;
  let matches = regex.exec(source);
  while (matches !== null) {
    const name = matches[1];
    // Add the property name if it isn't already in the array.
    if (propertyNames.indexOf(name) === -1) {
      propertyNames.push(name);
    }
    matches = regex.exec(source);
  }
}

// WHAT IF POINT CLOUDS DON'T HAVE A COLOR
// BUT THEY MODIFY COLORS....

// new varying: v_pointCloudColor
// fragment shader just needs a small constant function that
// sets the color to that

function getPropertyNames(shaderFunctionInfo) {
  const colorStyleFunction = shaderFunctionInfo.colorStyleFunction;
  const showStyleFunction = shaderFunctionInfo.showStyleFunction;
  const pointSizeStyleFunction = shaderFunctionInfo.pointSizeStyleFunction;

  // Get the properties in use by the style.
  const builtinPropertyNames = [];

  if (defined(colorStyleFunction)) {
    getBuiltinPropertyNames(colorStyleFunction, builtinPropertyNames);
  }
  if (defined(showStyleFunction)) {
    getBuiltinPropertyNames(showStyleFunction, builtinPropertyNames);
  }
  if (defined(pointSizeStyleFunction)) {
    getBuiltinPropertyNames(pointSizeStyleFunction, builtinPropertyNames);
  }

  return builtinPropertyNames;
}

export default PointCloudStylingPipelineStage;
