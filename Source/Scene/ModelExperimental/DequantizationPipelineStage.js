import defined from "../../Core/defined.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import ModelExperimentalUtility from "./ModelExperimentalUtility.js";

/**
 * The dequantization stage generates shader code to dequantize properties
 * in the fragment shader
 *
 * @namespace DequantizationPipelineStage
 *
 * @private
 */
var DequantizationPipelineStage = {};
DequantizationPipelineStage.name = "DequantizationPipelineStage"; // Helps with debugging

var dequantizationFunctionId = "dequantizationStage";

/**
 * Process a primitive with quantized properties. This stage modifies the
 * following parts of the render resources:
 * <ul>
 *  <li> adds attribute and varying declarations for the vertex attributes in the vertex and fragment shaders
 *  <li> creates the objects required to create VertexArrays
 *  <li> sets the flag for point primitive types
 * </ul>
 *
 * @param {PrimitiveRenderResources} renderResources The render resources for this primitive.
 * @param {ModelComponents.Primitive} primitive The primitive
 *
 * @private
 */
DequantizationPipelineStage.process = function (renderResources, primitive) {
  var shaderBuilder = renderResources.shaderBuilder;
  var functionId = "dequantizationStage";
  var signature =
    "void dequantizationStage(inout ProcessedAttributes attributes)";
  shaderBuilder.addFunction(functionId, signature, ShaderDestination.VERTEX);

  shaderBuilder.addDefine(
    "USE_DEQUANTIZATION",
    undefined,
    ShaderDestination.VERTEX
  );

  var attributes = primitive.attributes;
  for (var i = 0; i < attributes.length; i++) {
    var attribute = attributes[i];
    var quantization = attribute.quantization;
    if (!defined(quantization)) {
      // non-quantized attributes were already handled in GeometryPipelineStage
      continue;
    }
    var attributeInfo = ModelExperimentalUtility.getAttributeInfo(attribute);
    updateDequantizationFunction(shaderBuilder, attributeInfo);
    addDequantizationUniforms(renderResources, attributeInfo);
  }
};

function addDequantizationUniforms(renderResources, attributeInfo) {
  var shaderBuilder = renderResources.shaderBuilder;
  var uniformMap = renderResources.uniformMap;
  var variableName = attributeInfo.variableName;
  var quantization = attributeInfo.attribute.quantization;

  if (quantization.octEncoded) {
    var normalizationRange = "model_normalizationRange_" + variableName;
    shaderBuilder.addUniform(
      "float",
      normalizationRange,
      ShaderDestination.VERTEX
    );
    uniformMap[normalizationRange] = function () {
      return quantization.normalizationRange;
    };
  } else {
    var offset = "model_quantizedVolumeOffset_" + variableName;
    var stepSize = "model_quantizedVolumeStepSize_" + variableName;
    var glslType = attributeInfo.glslType;
    shaderBuilder.addUniform(glslType, offset, ShaderDestination.VERTEX);
    shaderBuilder.addUniform(glslType, stepSize, ShaderDestination.VERTEX);

    uniformMap[offset] = function () {
      return quantization.quantizedVolumeOffset;
    };

    uniformMap[stepSize] = function () {
      return quantization.quantizedVolumeStepSize;
    };
  }
}

function updateDequantizationFunction(shaderBuilder, attributeInfo) {
  var variableName = attributeInfo.variableName;
  var quantization = attributeInfo.attribute.quantization;

  var line;
  if (quantization.octEncoded) {
    line = generateOctDecodeLine(variableName, quantization);
  } else {
    line = generateDequantizeLine(variableName);
  }

  shaderBuilder.addFunctionLine(dequantizationFunctionId, line);
}

function generateOctDecodeLine(variableName, quantization) {
  var structField = "attributes." + variableName;

  var encodedAttribute = "a_encoded_" + variableName;
  var normalizationRange = "model_normalizationRange_" + variableName;

  // Draco stores things as .zxy instead of xyz, so be explicit about the
  // swizzle to avoid confusion
  var swizzle = quantization.octEncodedZXY ? ".zxy" : ".xyz";

  return (
    structField +
    " = czm_octDecode(" +
    encodedAttribute +
    ", " +
    normalizationRange +
    ")" +
    swizzle +
    ";"
  );
}

function generateDequantizeLine(variableName) {
  var structField = "attributes." + variableName;
  var encodedAttribute = "a_encoded_" + variableName;
  var offset = "model_quantizedVolumeOffset_" + variableName;
  var dimensions = "model_quantizedVolumeStepSize_" + variableName;
  return (
    structField +
    " = " +
    offset +
    " + " +
    encodedAttribute +
    " * " +
    dimensions +
    ";"
  );
}

export default DequantizationPipelineStage;
