import AttributeType from "../AttributeType.js";
import Buffer from "../../Renderer/Buffer.js";
import BufferUsage from "../../Renderer/BufferUsage.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import clone from "../../Core/clone.js";
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import defined from "../../Core/defined.js";
import InstanceAttributeSemantic from "../InstanceAttributeSemantic.js";
import InstancingStageCommon from "../../Shaders/ModelExperimental/InstancingStageCommon.js";
import InstancingStageVS from "../../Shaders/ModelExperimental/InstancingStageVS.js";
import LegacyInstancingStageVS from "../../Shaders/ModelExperimental/LegacyInstancingStageVS.js";
import Matrix4 from "../../Core/Matrix4.js";
import ModelExperimentalUtility from "./ModelExperimentalUtility.js";
import Quaternion from "../../Core/Quaternion.js";
import SceneMode from "../SceneMode.js";
import SceneTransforms from "../SceneTransforms.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";

const modelViewScratch = new Matrix4();
const nodeTransformScratch = new Matrix4();

/**
 * The instancing pipeline stage is responsible for handling GPU mesh instancing at the node
 * level.
 *
 * @namespace InstancingPipelineStage
 * @private
 */
const InstancingPipelineStage = {};
InstancingPipelineStage.name = "InstancingPipelineStage"; // Helps with debugging

/**
 * Process a node. This modifies the following parts of the render resources:
 * <ul>
 *  <li>adds attribute declarations for the instancing vertex attributes in the vertex shader</li>
 *  <li>adds an instancing translation min and max to compute an accurate bounding volume</li>
 * </ul>
 * @param {NodeRenderResources} renderResources The render resources for this node.
 * @param {ModelComponents.Node} node The node.
 * @param {FrameState} frameState The frame state.
 */
InstancingPipelineStage.process = function (renderResources, node, frameState) {
  const instances = node.instances;
  const count = instances.attributes[0].count;

  const shaderBuilder = renderResources.shaderBuilder;
  shaderBuilder.addDefine("HAS_INSTANCING");
  shaderBuilder.addVertexLines([InstancingStageCommon]);

  const model = renderResources.model;
  const sceneGraph = model.sceneGraph;
  const use2D =
    frameState.mode !== SceneMode.SCENE3D &&
    !frameState.scene3DOnly &&
    model._projectTo2D;

  const instancingVertexAttributes = [];

  processTransformAttributes(
    renderResources,
    frameState,
    instances,
    instancingVertexAttributes,
    use2D
  );

  processFeatureIdAttributes(
    renderResources,
    frameState,
    instances,
    instancingVertexAttributes
  );

  const uniformMap = renderResources.uniformMap;
  if (instances.transformInWorldSpace) {
    shaderBuilder.addDefine(
      "USE_LEGACY_INSTANCING",
      undefined,
      ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform(
      "mat4",
      "u_instance_modifiedModelView",
      ShaderDestination.VERTEX
    );
    shaderBuilder.addUniform(
      "mat4",
      "u_instance_nodeTransform",
      ShaderDestination.VERTEX
    );

    // The i3dm format applies the instancing transforms in world space.
    // Instancing matrices come from a vertex attribute rather than a
    // uniform, and they are multiplied in the middle of the modelView matrix
    // product. This means czm_modelView can't be used. Instead, we split the
    // matrix into two parts, modifiedModelView and nodeTransform, and handle
    // this in LegacyInstancingStageVS.glsl. Conceptually the product looks like
    // this:
    //
    // modelView = u_modifiedModelView * a_instanceTransform * u_nodeTransform
    uniformMap.u_instance_modifiedModelView = function () {
      // Model matrix without the node hierarchy or axis correction
      // (see u_instance_nodeTransform).
      const modifiedModelMatrix = Matrix4.multiplyTransformation(
        // For 3D Tiles, model.modelMatrix is the computed tile
        // transform (which includes tileset.modelMatrix). This always applies
        // for i3dm, since such models are always part of a tileset.
        model.modelMatrix,
        // For i3dm models, components.transform contains the RTC_CENTER
        // translation.
        sceneGraph.components.transform,
        modelViewScratch
      );

      // modifiedModelView = view * modifiedModel
      return Matrix4.multiplyTransformation(
        frameState.context.uniformState.view,
        modifiedModelMatrix,
        modelViewScratch
      );
    };

    uniformMap.u_instance_nodeTransform = function () {
      // nodeTransform = axisCorrection * nodeHierarchyTransform
      return Matrix4.multiplyTransformation(
        // glTF y-up to 3D Tiles z-up
        sceneGraph.axisCorrectionMatrix,
        // This transforms from the node's coordinate system to the root
        // of the node hierarchy
        renderResources.runtimeNode.computedTransform,
        nodeTransformScratch
      );
    };

    shaderBuilder.addVertexLines([LegacyInstancingStageVS]);
  } else {
    shaderBuilder.addVertexLines([InstancingStageVS]);
  }

  if (use2D) {
    shaderBuilder.addDefine("USE_2D_INSTANCING");

    uniformMap.u_modelView2D = function () {
      // add modelView2D uniform here. same gimmick as in scenemode2dpipelinestage
    };
  }

  renderResources.instanceCount = count;
  renderResources.attributes.push.apply(
    renderResources.attributes,
    instancingVertexAttributes
  );
};
const modelMatrixScratch = new Matrix4();
const nodeComputedTransformScratch = new Matrix4();

const translationMatrixScratch = new Matrix4();
const projectedPositionScratch = new Cartesian3();

function projectPositionTo2D(
  position,
  modelMatrix,
  nodeTransform,
  frameState,
  result
) {
  const translationMatrix = Matrix4.fromTranslation(
    position,
    translationMatrixScratch
  );
  const modelMatrixAndTranslation = Matrix4.multiplyTransformation(
    modelMatrix,
    translationMatrix,
    result
  );
  const finalTransform = Matrix4.multiplyTransformation(
    modelMatrixAndTranslation,
    nodeTransform,
    result
  );
  const finalPosition = Matrix4.getTranslation(
    finalTransform,
    projectedPositionScratch
  );

  result = SceneTransforms.computeActualWgs84Position(
    frameState,
    finalPosition,
    result
  );

  return result;
}

const positionScratch = new Cartesian3();

function projectTransformsTo2D(
  transforms,
  renderResources,
  frameState,
  referencePoint,
  result
) {
  const model = renderResources.model;
  const sceneGraph = model.sceneGraph;
  let modelMatrix = modelMatrixScratch;
  let nodeComputedTransform = nodeComputedTransformScratch;

  const instances = renderResources.runtimeNode.node.instances;
  if (instances.transformInWorldSpace) {
    // Replicate the multiplication order in LegacyInstancingStageVS.
    modelMatrix = Matrix4.multiplyTransformation(
      modelMatrix.modelMatrix,
      sceneGraph.components.transform,
      modelMatrix
    );

    nodeComputedTransform = Matrix4.multiplyByUniformScale(
      sceneGraph.axisCorrectionMatrix,
      model.computedScale,
      nodeComputedTransform
    );
    nodeComputedTransform = Matrix4.multiplyTransformation(
      nodeComputedTransform,
      renderResources.runtimeNode.computedTransform,
      nodeComputedTransform
    );
  } else {
    // The node transform should be pre-multiplied with the instancing transform.
    modelMatrix = Matrix4.clone(sceneGraph.computedModelMatrix, modelMatrix);
    modelMatrix = Matrix4.multiplyTransformation(
      modelMatrix,
      renderResources.runtimeNode.computedTransform,
      modelMatrix
    );

    nodeComputedTransform = Matrix4.clone(
      Matrix4.IDENTITY,
      nodeComputedTransform
    );
  }

  const count = transforms.length;
  for (let i = 0; i < count; i++) {
    const transform = transforms[i];
    const position = Matrix4.getTranslation(transform, positionScratch);
    const projectedPosition = projectPositionTo2D(
      position,
      modelMatrix,
      nodeComputedTransform,
      frameState,
      position
    );
    const finalTranslation = Cartesian3.subtract(
      projectedPosition,
      referencePoint,
      projectedPosition
    );

    result[i] = Matrix4.setTranslation(transform, finalTranslation, result[i]);
  }

  return result;
}

function transformsToTypedArray(transforms) {
  const elements = 12;
  const count = transforms.length;
  const transformsTypedArray = new Float32Array(count * elements);

  for (let i = 0; i < count; i++) {
    const transform = transforms[i];
    const offset = elements * i;

    transformsTypedArray[offset + 0] = transform[0];
    transformsTypedArray[offset + 1] = transform[4];
    transformsTypedArray[offset + 2] = transform[8];
    transformsTypedArray[offset + 3] = transform[12];
    transformsTypedArray[offset + 4] = transform[1];
    transformsTypedArray[offset + 5] = transform[5];
    transformsTypedArray[offset + 6] = transform[9];
    transformsTypedArray[offset + 7] = transform[13];
    transformsTypedArray[offset + 8] = transform[2];
    transformsTypedArray[offset + 9] = transform[6];
    transformsTypedArray[offset + 10] = transform[10];
    transformsTypedArray[offset + 11] = transform[14];
  }

  return transformsTypedArray;
}

const translationScratch = new Cartesian3();
const rotationScratch = new Quaternion();
const scaleScratch = new Cartesian3();

function getInstanceTransformsAsMatrices(instances, count, renderResources) {
  const transforms = new Array(count);

  const translationAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    instances,
    InstanceAttributeSemantic.TRANSLATION
  );
  const rotationAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    instances,
    InstanceAttributeSemantic.ROTATION
  );
  const scaleAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    instances,
    InstanceAttributeSemantic.SCALE
  );

  const instancingTranslationMax = new Cartesian3(
    -Number.MAX_VALUE,
    -Number.MAX_VALUE,
    -Number.MAX_VALUE
  );
  const instancingTranslationMin = new Cartesian3(
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    Number.MAX_VALUE
  );

  const hasTranslation = defined(translationAttribute);
  const hasRotation = defined(rotationAttribute);
  const hasScale = defined(scaleAttribute);

  // Translations get initialized to (0, 0, 0).
  const translationTypedArray = hasTranslation
    ? translationAttribute.packedTypedArray
    : new Float32Array(count * 3);
  // Rotations get initialized to (0, 0, 0, 0). The w-component is set to 1 in the loop below.
  const rotationTypedArray = hasRotation
    ? rotationAttribute.packedTypedArray
    : new Float32Array(count * 4);
  // Scales get initialized to (1, 1, 1).
  let scaleTypedArray;
  if (hasScale) {
    scaleTypedArray = scaleAttribute.packedTypedArray;
  } else {
    scaleTypedArray = new Float32Array(count * 3);
    scaleTypedArray.fill(1);
  }

  for (let i = 0; i < count; i++) {
    const translation = new Cartesian3(
      translationTypedArray[i * 3],
      translationTypedArray[i * 3 + 1],
      translationTypedArray[i * 3 + 2],
      translationScratch
    );

    Cartesian3.maximumByComponent(
      instancingTranslationMax,
      translation,
      instancingTranslationMax
    );
    Cartesian3.minimumByComponent(
      instancingTranslationMin,
      translation,
      instancingTranslationMin
    );

    const rotation = new Quaternion(
      rotationTypedArray[i * 4],
      rotationTypedArray[i * 4 + 1],
      rotationTypedArray[i * 4 + 2],
      hasRotation ? rotationTypedArray[i * 4 + 3] : 1,
      rotationScratch
    );

    const scale = new Cartesian3(
      scaleTypedArray[i * 3],
      scaleTypedArray[i * 3 + 1],
      scaleTypedArray[i * 3 + 2],
      scaleScratch
    );

    const transform = Matrix4.fromTranslationQuaternionRotationScale(
      translation,
      rotation,
      scale,
      new Matrix4()
    );

    transforms[i] = transform;
  }

  renderResources.instancingTranslationMax = instancingTranslationMax;
  renderResources.instancingTranslationMin = instancingTranslationMin;

  return transforms;
}

function processTransformAttributes(
  renderResources,
  frameState,
  instances,
  instancingVertexAttributes,
  use2D
) {
  const translationAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    instances,
    InstanceAttributeSemantic.TRANSLATION
  );

  let translationMax;
  let translationMin;
  if (defined(translationAttribute)) {
    translationMax = translationAttribute.max;
    translationMin = translationAttribute.min;
  }

  const rotationAttribute = ModelExperimentalUtility.getAttributeBySemantic(
    instances,
    InstanceAttributeSemantic.ROTATION
  );

  const shaderBuilder = renderResources.shaderBuilder;
  const count = instances.attributes[0].count;
  const useMatrices =
    defined(rotationAttribute) ||
    !defined(translationMax) ||
    !defined(translationMin);

  let transforms;
  if (useMatrices) {
    shaderBuilder.addDefine("HAS_INSTANCE_MATRICES");
    const attributeString = "instancingTransform";
    transforms = getInstanceTransformsAsMatrices(
      instances,
      count,
      renderResources,
      use2D
    );

    processMatrixAttributes(
      renderResources,
      transforms,
      frameState,
      instancingVertexAttributes,
      attributeString
    );
  } else {
    const scaleAttribute = ModelExperimentalUtility.getAttributeBySemantic(
      instances,
      InstanceAttributeSemantic.SCALE
    );

    processTranslationScaleAttributes(
      renderResources,
      translationAttribute,
      scaleAttribute,
      instancingVertexAttributes
    );
  }

  if (!use2D) {
    return;
  }

  // Force the scene mode to be CV. In 2D, projected positions will have
  // an x-coordinate of 0, which eliminates the height data that is
  // necessary for rendering in CV mode.
  const frameStateCV = clone(frameState);
  frameStateCV.mode = SceneMode.COLUMBUS_VIEW;

  // To prevent jitter, the positions are defined relative to a common
  // reference point. For convenience, this is the center of the instanced
  // translation bounds.
  const referencePoint = Cartesian3.lerp(
    renderResources.instancingTranslationMin,
    renderResources.instancingTranslationMax,
    0.5,
    new Cartesian3()
  );

  if (useMatrices) {
    const projectedTransforms = projectTransformsTo2D(
      transforms,
      renderResources,
      frameState,
      referencePoint,
      transforms
    );
    const attributeString2D = "instancingTransform2D";

    processMatrixAttributes(
      renderResources,
      projectedTransforms,
      frameState,
      instancingVertexAttributes,
      attributeString2D
    );
  } else {
    // TODO
  }
}

function processMatrixAttributes(
  renderResources,
  transforms,
  frameState,
  instancingVertexAttributes,
  attributeInfo
) {
  const transformsTypedArray = transformsToTypedArray(transforms);
  const transformsVertexBuffer = Buffer.createVertexBuffer({
    context: frameState.context,
    typedArray: transformsTypedArray,
    usage: BufferUsage.STATIC_DRAW,
  });
  // Destruction of resources allocated by the ModelExperimental is handled by ModelExperimental.destroy().
  transformsVertexBuffer.vertexArrayDestroyable = false;
  renderResources.model._resources.push(transformsVertexBuffer);

  const vertexSizeInFloats = 12;
  const componentByteSize = ComponentDatatype.getSizeInBytes(
    ComponentDatatype.FLOAT
  );
  const strideInBytes = componentByteSize * vertexSizeInFloats;

  const matrixAttributes = [
    {
      index: renderResources.attributeIndex++,
      vertexBuffer: transformsVertexBuffer,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      normalize: false,
      offsetInBytes: 0,
      strideInBytes: strideInBytes,
      instanceDivisor: 1,
    },
    {
      index: renderResources.attributeIndex++,
      vertexBuffer: transformsVertexBuffer,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      normalize: false,
      offsetInBytes: componentByteSize * 4,
      strideInBytes: strideInBytes,
      instanceDivisor: 1,
    },
    {
      index: renderResources.attributeIndex++,
      vertexBuffer: transformsVertexBuffer,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      normalize: false,
      offsetInBytes: componentByteSize * 8,
      strideInBytes: strideInBytes,
      instanceDivisor: 1,
    },
  ];

  const shaderBuilder = renderResources.shaderBuilder;
  shaderBuilder.addDefine(attributeInfo.defineString);

  const attributeString = attributeInfo.attributeString;
  shaderBuilder.addAttribute("vec4", `a_${attributeString}Row0`);
  shaderBuilder.addAttribute("vec4", `a_${attributeString}Row1`);
  shaderBuilder.addAttribute("vec4", `a_${attributeString}Row2`);

  instancingVertexAttributes.push.apply(
    instancingVertexAttributes,
    matrixAttributes
  );
}

function processTranslationScaleAttributes(
  renderResources,
  translationAttribute,
  scaleAttribute,
  instancingVertexAttributes
) {
  const shaderBuilder = renderResources.shaderBuilder;
  if (defined(translationAttribute)) {
    const translationMax = translationAttribute.max;
    const translationMin = translationAttribute.min;

    instancingVertexAttributes.push({
      index: renderResources.attributeIndex++,
      vertexBuffer: translationAttribute.buffer,
      componentsPerAttribute: AttributeType.getNumberOfComponents(
        translationAttribute.type
      ),
      componentDatatype: translationAttribute.componentDatatype,
      normalize: false,
      offsetInBytes: translationAttribute.byteOffset,
      strideInBytes: translationAttribute.byteStride,
      instanceDivisor: 1,
    });

    renderResources.instancingTranslationMax = translationMax;
    renderResources.instancingTranslationMin = translationMin;

    shaderBuilder.addDefine("HAS_INSTANCE_TRANSLATION");
    shaderBuilder.addAttribute("vec3", "a_instanceTranslation");
  }

  if (defined(scaleAttribute)) {
    instancingVertexAttributes.push({
      index: renderResources.attributeIndex++,
      vertexBuffer: scaleAttribute.buffer,
      componentsPerAttribute: AttributeType.getNumberOfComponents(
        scaleAttribute.type
      ),
      componentDatatype: scaleAttribute.componentDatatype,
      normalize: false,
      offsetInBytes: scaleAttribute.byteOffset,
      strideInBytes: scaleAttribute.byteStride,
      instanceDivisor: 1,
    });

    shaderBuilder.addDefine("HAS_INSTANCE_SCALE");
    shaderBuilder.addAttribute("vec3", "a_instanceScale");
  }
}

function processFeatureIdAttributes(
  renderResources,
  frameState,
  instances,
  instancingVertexAttributes,
  transformMatrices
) {
  const attributes = instances.attributes;
  const model = renderResources.model;
  const shaderBuilder = renderResources.shaderBuilder;

  // Load Feature ID vertex attributes. These are loaded as typed arrays in GltfLoader
  // because we want to expose the instance feature ID when picking.
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes[i];
    if (attribute.semantic !== InstanceAttributeSemantic.FEATURE_ID) {
      continue;
    }

    if (
      attribute.setIndex >= renderResources.featureIdVertexAttributeSetIndex
    ) {
      renderResources.featureIdVertexAttributeSetIndex = attribute.setIndex + 1;
    }

    const vertexBuffer = Buffer.createVertexBuffer({
      context: frameState.context,
      typedArray: attribute.packedTypedArray,
      usage: BufferUsage.STATIC_DRAW,
    });
    vertexBuffer.vertexArrayDestroyable = false;
    model._resources.push(vertexBuffer);

    instancingVertexAttributes.push({
      index: renderResources.attributeIndex++,
      vertexBuffer: vertexBuffer,
      componentsPerAttribute: AttributeType.getNumberOfComponents(
        attribute.type
      ),
      componentDatatype: attribute.componentDatatype,
      normalize: false,
      offsetInBytes: attribute.byteOffset,
      strideInBytes: attribute.byteStride,
      instanceDivisor: 1,
    });

    shaderBuilder.addAttribute(
      "float",
      `a_instanceFeatureId_${attribute.setIndex}`
    );
  }
}

// Exposed for testing
InstancingPipelineStage._getInstanceTransformsAsMatrices = getInstanceTransformsAsMatrices;
InstancingPipelineStage._transformsToTypedArray = transformsToTypedArray;

export default InstancingPipelineStage;
