/**
 * Rendering statistics for a single model
 *
 * @alias ModelExperimentalStatistics
 * @constructor
 *
 * @see {@link Cesium3DTilesetStatistics}
 *
 * @private
 */
export default function ModelExperimentalStatistics() {
  this.pointsLength = 0;
  this.trianglesLength = 0;
  this.geometryByteLength = 0;
  this.texturesByteLength = 0;
}

/**
 * Reset the memory counts for this model. This should be called each time the
 * draw command pipeline is rebuilt.
 *
 * @private
 */
ModelExperimentalStatistics.prototype.clear = function () {
  this.pointsLength = 0;
  this.trianglesLength = 0;
  this.geometryByteLength = 0;
  this.texturesByteLength = 0;
};

ModelExperimentalStatistics.prototype.addBuffer = function (buffer) {
  // TODO: what about caching?
  // TODO: What if this is present on the CPU as well?
  this.geometryByteLength += buffer.sizeInBytes;
};

ModelExperimentalStatistics.prototype.addTexture = function (texture) {
  // TODO: what about caching?
  this.geometryByteLength += texture.sizeInBytes;
};
