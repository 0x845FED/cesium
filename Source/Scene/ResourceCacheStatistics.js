import defined from "../Core/defined.js";

export default function ResourceCacheStatistics() {
  this.geometryByteLength = 0;
  this.texturesByteLength = 0;

  this._geometrySizes = {};
  this._textureSizes = {};
}

ResourceCacheStatistics.prototype.clear = function () {
  this.geometryByteLength = 0;
  this.texturesByteLength = 0;

  this._geometrySizes = {};
  this._textureSizes = {};
};

ResourceCacheStatistics.prototype.addGeometryLoader = function (loader) {
  const cacheKey = loader.cacheKey;

  // Don't double count the same resource.
  if (this._geometrySizes.hasOwnProperty(cacheKey)) {
    return;
  }

  this._geometrySizes[cacheKey] = 0;

  const that = this;
  return loader.promise
    .then(function (loader) {
      // loader was unloaded before its promise resolved
      if (!that._geometrySizes.hasOwnProperty(cacheKey)) {
        return;
      }

      const buffer = loader.buffer;
      const typedArray = loader.typedArray;

      let totalSize = 0;

      if (defined(buffer)) {
        totalSize += buffer.sizeInBytes;
      }

      if (defined(typedArray)) {
        totalSize += typedArray.byteLength;
      }

      that.geometryByteLength += totalSize;
      that._geometrySizes[cacheKey] = totalSize;
    })
    .catch(function () {
      // If the resource failed to load, remove it from the cache
      delete that._geometrySizes[cacheKey];
    });
};

ResourceCacheStatistics.prototype.addTextureLoader = function (loader) {
  const cacheKey = loader.cacheKey;

  // Don't double count the same resource.
  if (this._textureSizes.hasOwnProperty(cacheKey)) {
    return;
  }

  this._textureSizes[cacheKey] = 0;

  const that = this;
  return loader.promise
    .then(function (loader) {
      // loader was unloaded before its promise resolved
      if (!that._textureSizes.hasOwnProperty(cacheKey)) {
        return;
      }

      const totalSize = loader.texture.sizeInBytes;
      that.texturesByteLength += loader.texture.sizeInBytes;
      that._textureSizes[cacheKey] = totalSize;
    })
    .catch(function () {
      delete that._textureSizes[cacheKey];
    });
};

ResourceCacheStatistics.prototype.removeLoader = function (loader) {
  const cacheKey = loader.cacheKey;
  const geometrySize = this._geometrySizes[cacheKey];
  delete this._geometrySizes[cacheKey];

  if (defined(geometrySize)) {
    this.geometryByteLength -= geometrySize;
  }

  const textureSize = this._textureSizes[cacheKey];
  delete this._textureSizes[cacheKey];

  if (defined(textureSize)) {
    this.texturesByteLength -= textureSize;
  }
};
