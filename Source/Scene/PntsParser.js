import arraySlice from "../Core/arraySlice.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import combine from "../Core/combine.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import getJsonFromTypedArray from "../Core/getJsonFromTypedArray.js";
import RuntimeError from "../Core/RuntimeError.js";
import AttributeType from "./AttributeType.js";
import Cesium3DTileBatchTable from "./Cesium3DTileBatchTable.js";
import Cesium3DTileFeatureTable from "./Cesium3DTileFeatureTable.js";
import VertexAttributeSemantic from "./VertexAttributeSemantic.js";

var PntsParser = {};

var sizeOfUint32 = Uint32Array.BYTES_PER_ELEMENT;

PntsParser.parse = function (arrayBuffer, byteOffset) {
  byteOffset = defaultValue(byteOffset, 0);

  var uint8Array = new Uint8Array(arrayBuffer);
  var view = new DataView(arrayBuffer);
  byteOffset += sizeOfUint32; // Skip magic

  var version = view.getUint32(byteOffset, true);
  if (version !== 1) {
    throw new RuntimeError(
      "Only Point Cloud tile version 1 is supported.  Version " +
        version +
        " is not."
    );
  }
  byteOffset += sizeOfUint32;

  // Skip byteLength
  byteOffset += sizeOfUint32;

  var featureTableJsonByteLength = view.getUint32(byteOffset, true);
  if (featureTableJsonByteLength === 0) {
    throw new RuntimeError(
      "Feature table must have a byte length greater than zero"
    );
  }
  byteOffset += sizeOfUint32;

  var featureTableBinaryByteLength = view.getUint32(byteOffset, true);
  byteOffset += sizeOfUint32;

  var batchTableJsonByteLength = view.getUint32(byteOffset, true);
  byteOffset += sizeOfUint32;
  var batchTableBinaryByteLength = view.getUint32(byteOffset, true);
  byteOffset += sizeOfUint32;

  var featureTableJson = getJsonFromTypedArray(
    uint8Array,
    byteOffset,
    featureTableJsonByteLength
  );
  byteOffset += featureTableJsonByteLength;

  var featureTableBinary = new Uint8Array(
    arrayBuffer,
    byteOffset,
    featureTableBinaryByteLength
  );
  byteOffset += featureTableBinaryByteLength;

  // Get the batch table JSON and binary
  var batchTableJson;
  var batchTableBinary;
  if (batchTableJsonByteLength > 0) {
    // Has a batch table JSON
    batchTableJson = getJsonFromTypedArray(
      uint8Array,
      byteOffset,
      batchTableJsonByteLength
    );
    byteOffset += batchTableJsonByteLength;

    if (batchTableBinaryByteLength > 0) {
      // Has a batch table binary
      batchTableBinary = new Uint8Array(
        arrayBuffer,
        byteOffset,
        batchTableBinaryByteLength
      );
      byteOffset += batchTableBinaryByteLength;
    }
  }

  var featureTable = new Cesium3DTileFeatureTable(
    featureTableJson,
    featureTableBinary
  );

  var pointsLength = featureTable.getGlobalProperty("POINTS_LENGTH");
  featureTable.featuresLength = pointsLength;

  var rtcCenter = featureTable.getGlobalProperty(
    "RTC_CENTER",
    ComponentDatatype.FLOAT,
    3
  );
  rtcCenter = Cartesian3.unpack(rtcCenter);

  var dracoProperties = parseDracoProperties(featureTable, batchTableJson);
  var results = {
    pointsLength: pointsLength,
    rtcCenter: rtcCenter,
    draco: dracoProperties.draco,
  };

  if (!dracoProperties.hasPositions) {
    results.positions = parsePositions(featureTable);
  }

  if (!dracoProperties.hasNormals) {
    results.normals = parseNormals(featureTable);
  }

  if (!dracoProperties.hasColors) {
    results.colors = parseColors(featureTable);
  }

  if (!dracoProperties.hasBatchIds) {
    results.batchIds = parseBatchIds(featureTable);
  }

  var hasBatchIds = defined(results.batchIds) || dracoProperties.hasBatchIds;

  if (!hasBatchIds && defined(batchTableBinary)) {
    results.styleableProperties = Cesium3DTileBatchTable.getBinaryProperties(
      pointsLength,
      batchTableJson,
      batchTableBinary
    );
  }

  return results;
};

function parseDracoProperties(featureTable, batchTableJson) {
  var featureTableJson = featureTable.json;
  var dracoBuffer;
  var dracoFeatureTableProperties;
  var dracoBatchTableProperties;

  var featureTableDraco = defined(featureTableJson.extensions)
    ? featureTableJson.extensions["3DTILES_draco_point_compression"]
    : undefined;
  var batchTableDraco =
    defined(batchTableJson) && defined(batchTableJson.extensions)
      ? batchTableJson.extensions["3DTILES_draco_point_compression"]
      : undefined;

  if (defined(batchTableDraco)) {
    dracoBatchTableProperties = batchTableDraco.properties;
  }

  var hasPositions;
  var hasColors;
  var hasNormals;
  var hasBatchIds;
  var isTranslucent;
  if (defined(featureTableDraco)) {
    dracoFeatureTableProperties = featureTableDraco.properties;
    var dracoByteOffset = featureTableDraco.byteOffset;
    var dracoByteLength = featureTableDraco.byteLength;
    if (
      !defined(dracoFeatureTableProperties) ||
      !defined(dracoByteOffset) ||
      !defined(dracoByteLength)
    ) {
      throw new RuntimeError(
        "Draco properties, byteOffset, and byteLength must be defined"
      );
    }
    dracoBuffer = arraySlice(
      featureTable.buffer,
      dracoByteOffset,
      dracoByteOffset + dracoByteLength
    );
    hasPositions = defined(dracoFeatureTableProperties.POSITION);
    hasColors =
      defined(dracoFeatureTableProperties.RGB) ||
      defined(dracoFeatureTableProperties.RGBA);
    hasNormals = defined(dracoFeatureTableProperties.NORMAL);
    hasBatchIds = defined(dracoFeatureTableProperties.BATCH_ID);
    isTranslucent = defined(dracoFeatureTableProperties.RGBA);
  }

  var draco;
  if (defined(dracoBuffer)) {
    draco = {
      buffer: dracoBuffer,
      featureTableProperties: dracoFeatureTableProperties,
      batchTableProperties: dracoBatchTableProperties,
      properties: combine(
        dracoFeatureTableProperties,
        dracoBatchTableProperties
      ),
      dequantizeInShader: true,
    };
  }

  return {
    draco: draco,
    hasPositions: hasPositions,
    hasColors: hasColors,
    isTranslucent: isTranslucent,
    hasNormals: hasNormals,
    hasBatchIds: hasBatchIds,
  };
}

function parsePositions(featureTable) {
  var featureTableJson = featureTable.json;

  var positions;
  if (defined(featureTableJson.POSITION)) {
    positions = featureTable.getPropertyArray(
      "POSITION",
      ComponentDatatype.FLOAT,
      3
    );

    return {
      name: "POSITION",
      semantic: "POSITION",
      typedArray: positions,
      isQuantized: false,
      componentDatatype: ComponentDatatype.FLOAT,
      type: AttributeType.VEC3,
    };
  } else if (defined(featureTableJson.POSITION_QUANTIZED)) {
    positions = featureTable.getPropertyArray(
      "POSITION_QUANTIZED",
      ComponentDatatype.UNSIGNED_SHORT,
      3
    );

    var quantizedVolumeScale = featureTable.getGlobalProperty(
      "QUANTIZED_VOLUME_SCALE",
      ComponentDatatype.FLOAT,
      3
    );
    if (!defined(quantizedVolumeScale)) {
      throw new RuntimeError(
        "Global property: QUANTIZED_VOLUME_SCALE must be defined for quantized positions."
      );
    }
    var quantizedRange = (1 << 16) - 1;

    var quantizedVolumeOffset = featureTable.getGlobalProperty(
      "QUANTIZED_VOLUME_OFFSET",
      ComponentDatatype.FLOAT,
      3
    );
    if (!defined(quantizedVolumeOffset)) {
      throw new RuntimeError(
        "Global property: QUANTIZED_VOLUME_OFFSET must be defined for quantized positions."
      );
    }

    return {
      name: "POSITION",
      semantic: VertexAttributeSemantic.POSITION,
      typedArray: positions,
      isQuantized: true,
      componentDatatype: ComponentDatatype.FLOAT,
      type: AttributeType.VEC3,
      quantizedRange: quantizedRange,
      quantizedVolumeOffset: Cartesian3.unpack(quantizedVolumeOffset),
      quantizedVolumeScale: Cartesian3.unpack(quantizedVolumeScale),
      quantizedComponentDatatype: ComponentDatatype.UNSIGNED_SHORT,
      quantizedType: AttributeType.VEC3,
    };
  }
}

function parseColors(featureTable) {
  var featureTableJson = featureTable.json;

  var colors;
  if (defined(featureTableJson.RGBA)) {
    colors = featureTable.getPropertyArray(
      "RGBA",
      ComponentDatatype.UNSIGNED_BYTE,
      4
    );
    return {
      name: "COLOR",
      semantic: VertexAttributeSemantic.COLOR,
      setIndex: 0,
      typedArray: colors,
      componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
      componentsPerAttribute: 4,
      normalized: true,
      isRGB565: false,
    };
  } else if (defined(featureTableJson.RGB)) {
    colors = featureTable.getPropertyArray(
      "RGB",
      ComponentDatatype.UNSIGNED_BYTE,
      3
    );
    return {
      name: "COLOR",
      semantic: VertexAttributeSemantic.COLOR,
      typedArray: colors,
      componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
      componentsPerAttribute: 3,
      normalized: true,
      isRGB565: false,
    };
  } else if (defined(featureTableJson.RGB565)) {
    // TODO: Parse on the CPU, this feature isn't used often enough to
    // warrant the GPU complexity.
    colors = featureTable.getPropertyArray(
      "RGB565",
      ComponentDatatype.UNSIGNED_SHORT,
      1
    );
    return {
      typedArray: colors,
      componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
      componentsPerAttribute: 1,
      normalized: false,
      isRGB565: true,
    };
  } else if (defined(featureTableJson.CONSTANT_RGBA)) {
    var constantRGBA = featureTable.getGlobalProperty(
      "CONSTANT_RGBA",
      ComponentDatatype.UNSIGNED_BYTE,
      4
    );
    // TODO: default should be dark grey... where should that be handled?
    var constantColor = Color.fromBytes(
      constantRGBA[0],
      constantRGBA[1],
      constantRGBA[2],
      constantRGBA[3]
    );

    return {
      constantColor: constantColor,
    };
  }

  return undefined;
}

function parseNormals(featureTable) {
  var featureTableJson = featureTable.json;
  var normals;
  if (defined(featureTableJson.NORMAL)) {
    normals = featureTable.getPropertyArray(
      "NORMAL",
      ComponentDatatype.FLOAT,
      3
    );
    return {
      name: "NORMAL",
      semantic: VertexAttributeSemantic.NORMAL,
      typedArray: normals,
      isOctEncoded: false,
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
    };
  } else if (defined(featureTableJson.NORMAL_OCT16P)) {
    normals = featureTable.getPropertyArray(
      "NORMAL_OCT16P",
      ComponentDatatype.UNSIGNED_BYTE,
      2
    );
    return {
      name: "NORMAL",
      semantic: VertexAttributeSemantic.COLOR,
      typedArray: normals,
      isOctEncoded: true,
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
    };
  }

  return undefined;
}

function parseBatchIds(featureTable) {
  var featureTableJson = featureTable.json;
  if (defined(featureTableJson.BATCH_ID)) {
    var batchIds = featureTable.getPropertyArray(
      "BATCH_ID",
      ComponentDatatype.UNSIGNED_SHORT,
      1
    );
    return {
      typedArray: batchIds,
      componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
      componentsPerAttribute: 1,
    };
  }

  return undefined;
}

export default PntsParser;
