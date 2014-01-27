/*global define*/
define([
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/BoundingSphere',
        '../Core/Cartesian3',
        '../Core/Cartographic',
        '../Core/DeveloperError',
        '../Core/Ellipsoid',
        '../Core/EllipsoidalOccluder',
        '../Core/HeightmapTessellator',
        '../Core/Intersections2D',
        '../Core/Math',
        '../Core/TaskProcessor',
        './GeographicTilingScheme',
        './HeightmapTerrainData',
        './TerrainMesh',
        './TerrainProvider',
        '../ThirdParty/when'
    ], function(
        defaultValue,
        defined,
        BoundingSphere,
        Cartesian3,
        Cartographic,
        DeveloperError,
        Ellipsoid,
        EllipsoidalOccluder,
        HeightmapTessellator,
        Intersections2D,
        CesiumMath,
        TaskProcessor,
        GeographicTilingScheme,
        HeightmapTerrainData,
        TerrainMesh,
        TerrainProvider,
        when) {
    "use strict";

    var vertexStride = 6;
    var xIndex = 0;
    var yIndex = 1;
    var zIndex = 2;
    var hIndex = 3;
    var uIndex = 4;
    var vIndex = 5;

    /**
     * Terrain data for a single tile where the terrain data is represented as a heightmap.  A heightmap
     * is a rectangular array of heights in row-major order from south to north and west to east.
     *
     * @alias MeshTerrainData
     * @constructor
     *
     * @param {TypedArray} description.buffer The buffer containing height data.
     * @param {Number} description.width The width (longitude direction) of the heightmap, in samples.
     * @param {Number} description.height The height (latitude direction) of the heightmap, in samples.
     * @param {Number} [description.childTileMask=15] A bit mask indicating which of this tile's four children exist.
     *                 If a child's bit is set, geometry will be requested for that tile as well when it
     *                 is needed.  If the bit is cleared, the child tile is not requested and geometry is
     *                 instead upsampled from the parent.  The bit values are as follows:
     *                 <table>
     *                  <tr><th>Bit Position</th><th>Bit Value</th><th>Child Tile</th></tr>
     *                  <tr><td>0</td><td>1</td><td>Southwest</td></tr>
     *                  <tr><td>1</td><td>2</td><td>Southeast</td></tr>
     *                  <tr><td>2</td><td>4</td><td>Northwest</td></tr>
     *                  <tr><td>3</td><td>8</td><td>Northeast</td></tr>
     *                 </table>
     * @param {Object} [description.structure] An object describing the structure of the height data.
     * @param {Number} [description.structure.heightScale=1.0] The factor by which to multiply height samples in order to obtain
     *                 the height above the heightOffset, in meters.  The heightOffset is added to the resulting
     *                 height after multiplying by the scale.
     * @param {Number} [description.structure.heightOffset=0.0] The offset to add to the scaled height to obtain the final
     *                 height in meters.  The offset is added after the height sample is multiplied by the
     *                 heightScale.
     * @param {Number} [description.structure.elementsPerHeight=1] The number of elements in the buffer that make up a single height
     *                 sample.  This is usually 1, indicating that each element is a separate height sample.  If
     *                 it is greater than 1, that number of elements together form the height sample, which is
     *                 computed according to the structure.elementMultiplier and structure.isBigEndian properties.
     * @param {Number} [description.structure.stride=1] The number of elements to skip to get from the first element of
     *                 one height to the first element of the next height.
     * @param {Number} [description.structure.elementMultiplier=256.0] The multiplier used to compute the height value when the
     *                 stride property is greater than 1.  For example, if the stride is 4 and the strideMultiplier
     *                 is 256, the height is computed as follows:
     *                 `height = buffer[index] + buffer[index + 1] * 256 + buffer[index + 2] * 256 * 256 + buffer[index + 3] * 256 * 256 * 256`
     *                 This is assuming that the isBigEndian property is false.  If it is true, the order of the
     *                 elements is reversed.
     * @param {Boolean} [description.structure.isBigEndian=false] Indicates endianness of the elements in the buffer when the
     *                  stride property is greater than 1.  If this property is false, the first element is the
     *                  low-order element.  If it is true, the first element is the high-order element.
     * @param {Boolean} [description.createdByUpsampling=false] True if this instance was created by upsampling another instance;
     *                  otherwise, false.
     *
     * @see TerrainData
     *
     * @example
     * var buffer = ...
     * var heightBuffer = new Uint16Array(buffer, 0, that._heightmapWidth * that._heightmapWidth);
     * var childTileMask = new Uint8Array(buffer, heightBuffer.byteLength, 1)[0];
     * var waterMask = new Uint8Array(buffer, heightBuffer.byteLength + 1, buffer.byteLength - heightBuffer.byteLength - 1);
     * var structure = HeightmapTessellator.DEFAULT_STRUCTURE;
     * var terrainData = new HeightmapTerrainData({
     *   buffer : heightBuffer,
     *   width : 65,
     *   height : 65,
     *   childTileMask : childTileMask,
     *   structure : structure,
     *   waterMask : waterMask
     * });
     */
    var MeshTerrainData = function MeshTerrainData(description) {
        if (!defined(description) || !defined(description.quantizedVertices)) {
            throw new DeveloperError('description.quantizedVertices is required.');
        }
        if (!defined(description.indices)) {
            throw new DeveloperError('description.indices is required.');
        }
        if (!defined(description.minimumHeight)) {
            throw new DeveloperError('description.minimumHeight is required.');
        }
        if (!defined(description.maximumHeight)) {
            throw new DeveloperError('description.maximumHeight is required.');
        }
        if (!defined(description.maximumHeight)) {
            throw new DeveloperError('description.maximumHeight is required.');
        }
        if (!defined(description.boundingSphere)) {
            throw new DeveloperError('description.boundingSphere is required.');
        }
        if (!defined(description.horizonOcclusionPoint)) {
            throw new DeveloperError('description.horizonOcclusionPoint is required.');
        }
        if (!defined(description.westIndices)) {
            throw new DeveloperError('description.westIndices is required.');
        }
        if (!defined(description.southIndices)) {
            throw new DeveloperError('description.southIndices is required.');
        }
        if (!defined(description.eastIndices)) {
            throw new DeveloperError('description.eastIndices is required.');
        }
        if (!defined(description.northIndices)) {
            throw new DeveloperError('description.northIndices is required.');
        }
        if (!defined(description.westSkirtHeight)) {
            throw new DeveloperError('description.westSkirtHeight is required.');
        }
        if (!defined(description.southSkirtHeight)) {
            throw new DeveloperError('description.southSkirtHeight is required.');
        }
        if (!defined(description.eastSkirtHeight)) {
            throw new DeveloperError('description.eastSkirtHeight is required.');
        }
        if (!defined(description.northSkirtHeight)) {
            throw new DeveloperError('description.northSkirtHeight is required.');
        }
        if (!defined(description.childTileMask)) {
            throw new DeveloperError('description.childTileMask is required.');
        }

        this._quantizedVertices = description.quantizedVertices;
        this._indices = description.indices;
        this._minimumHeight = description.minimumHeight;
        this._maximumHeight = description.maximumHeight;
        this._boundingSphere = description.boundingSphere;
        this._horizonOcclusionPoint = description.horizonOcclusionPoint;

        // TODO: these toArray calls are not necessary if we can count on the edge vertices being sorted.
        this._westIndices = toArray(description.westIndices);
        this._southIndices = toArray(description.southIndices);
        this._eastIndices = toArray(description.eastIndices);
        this._northIndices = toArray(description.northIndices);

        this._westSkirtHeight = description.westSkirtHeight;
        this._southSkirtHeight = description.southSkirtHeight;
        this._eastSkirtHeight = description.eastSkirtHeight;
        this._northSkirtHeight = description.northSkirtHeight;

        this._childTileMask = description.childTileMask;

        this._createdByUpsampling = defaultValue(description.createdByUpsampling, false);
        this._waterMask = description.waterMask;
    };

    function toArray(typedArray) {
        var result = new Array(typedArray.length);
        for (var i = 0, len = typedArray.length; i < len; ++i) {
            result[i] = typedArray[i];
        }
        return result;
    }

    var cartesian3Scratch = new Cartesian3();
    var cartographicScratch = new Cartographic();

    var createMeshTaskProcessor = new TaskProcessor('createVerticesFromQuantizedTerrainMesh');

    /**
     * Creates a {@link TerrainMesh} from this terrain data.
     *
     * @memberof HeightmapTerrainData
     *
     * @param {TilingScheme} tilingScheme The tiling scheme to which this tile belongs.
     * @param {Number} x The X coordinate of the tile for which to create the terrain data.
     * @param {Number} y The Y coordinate of the tile for which to create the terrain data.
     * @param {Number} level The level of the tile for which to create the terrain data.
     * @returns {Promise|TerrainMesh} A promise for the terrain mesh, or undefined if too many
     *          asynchronous mesh creations are already in progress and the operation should
     *          be retried later.
     */
    MeshTerrainData.prototype.createMesh = function(tilingScheme, x, y, level) {
        if (typeof tilingScheme === 'undefined') {
            throw new DeveloperError('tilingScheme is required.');
        }
        if (typeof x === 'undefined') {
            throw new DeveloperError('x is required.');
        }
        if (typeof y === 'undefined') {
            throw new DeveloperError('y is required.');
        }
        if (typeof level === 'undefined') {
            throw new DeveloperError('level is required.');
        }

        var ellipsoid = tilingScheme.getEllipsoid();
        var extent = tilingScheme.tileXYToExtent(x, y, level);

        var verticesPromise = createMeshTaskProcessor.scheduleTask({
            minimumHeight : this._minimumHeight,
            maximumHeight : this._maximumHeight,
            quantizedVertices : this._quantizedVertices,
            indices : this._indices,
            westIndices : this._westIndices,
            southIndices : this._southIndices,
            eastIndices : this._eastIndices,
            northIndices : this._northIndices,
            westSkirtHeight : this._westSkirtHeight,
            southSkirtHeight : this._southSkirtHeight,
            eastSkirtHeight : this._eastSkirtHeight,
            northSkirtHeight : this._northSkirtHeight,
            extent : extent,
            relativeToCenter : this._boundingSphere.center,
            ellipsoid : ellipsoid
        });

        if (!defined(verticesPromise)) {
            // Postponed
            return undefined;
        }

        var that = this;
        return when(verticesPromise, function(result) {
            return new TerrainMesh(
                    that._boundingSphere.center,
                    new Float32Array(result.vertices),
                    new Uint16Array(result.indices),
                    that._minimumHeight,
                    that._maximumHeight,
                    that._boundingSphere,
                    that._horizonOcclusionPoint);
        });
    };

    var upsampleTaskProcessor = new TaskProcessor('upsampleQuantizedTerrainMesh');

    /**
     * Upsamples this terrain data for use by a descendant tile.  The resulting instance will contain a subset of the
     * height samples in this instance, interpolated if necessary.
     *
     * @memberof HeightmapTerrainData
     *
     * @param {TilingScheme} tilingScheme The tiling scheme of this terrain data.
     * @param {Number} thisX The X coordinate of this tile in the tiling scheme.
     * @param {Number} thisY The Y coordinate of this tile in the tiling scheme.
     * @param {Number} thisLevel The level of this tile in the tiling scheme.
     * @param {Number} descendantX The X coordinate within the tiling scheme of the descendant tile for which we are upsampling.
     * @param {Number} descendantY The Y coordinate within the tiling scheme of the descendant tile for which we are upsampling.
     * @param {Number} descendantLevel The level within the tiling scheme of the descendant tile for which we are upsampling.
     *
     * @returns {Promise|HeightmapTerrainData} A promise for upsampled heightmap terrain data for the descendant tile,
     *          or undefined if too many asynchronous upsample operations are in progress and the request has been
     *          deferred.
     */
    MeshTerrainData.prototype.upsample = function(tilingScheme, thisX, thisY, thisLevel, descendantX, descendantY, descendantLevel) {
        if (typeof tilingScheme === 'undefined') {
            throw new DeveloperError('tilingScheme is required.');
        }
        if (typeof thisX === 'undefined') {
            throw new DeveloperError('thisX is required.');
        }
        if (typeof thisY === 'undefined') {
            throw new DeveloperError('thisY is required.');
        }
        if (typeof thisLevel === 'undefined') {
            throw new DeveloperError('thisLevel is required.');
        }
        if (typeof descendantX === 'undefined') {
            throw new DeveloperError('descendantX is required.');
        }
        if (typeof descendantY === 'undefined') {
            throw new DeveloperError('descendantY is required.');
        }
        if (typeof descendantLevel === 'undefined') {
            throw new DeveloperError('descendantLevel is required.');
        }

        var levelDifference = descendantLevel - thisLevel;
        if (levelDifference > 1) {
            throw new DeveloperError('Upsampling through more than one level at a time is not currently supported.');
        }

        var isEastChild = thisX * 2 !== descendantX;
        var isNorthChild = thisY * 2 === descendantY;

        var ellipsoid = tilingScheme.getEllipsoid();
        var childExtent = tilingScheme.tileXYToExtent(descendantX, descendantY, descendantLevel);

        var upsamplePromise = upsampleTaskProcessor.scheduleTask({
            vertices : this._quantizedVertices,
            indices : this._indices,
            minimumHeight : this._minimumHeight,
            maximumHeight : this._maximumHeight,
            isEastChild : isEastChild,
            isNorthChild : isNorthChild,
            childExtent : childExtent,
            ellipsoid : ellipsoid
        });

        if (!defined(upsamplePromise)) {
            // Postponed
            return undefined;
        }

        var shortestSkirt = Math.min(this._westSkirtHeight, this._eastSkirtHeight);
        shortestSkirt = Math.min(shortestSkirt, this._southSkirtHeight);
        shortestSkirt = Math.min(shortestSkirt, this._northSkirtHeight);

        var westSkirtHeight = isEastChild ? (shortestSkirt * 0.5) : this._westSkirtHeight;
        var southSkirtHeight = isNorthChild ? (shortestSkirt * 0.5) : this._southSkirtHeight;
        var eastSkirtHeight = isEastChild ? this._eastSkirtHeight : (shortestSkirt * 0.5);
        var northSkirtHeight = isNorthChild ? this._northSkirtHeight : (shortestSkirt * 0.5);

        var that = this;
        return when(upsamplePromise, function(result) {
            return new MeshTerrainData({
                quantizedVertices : new Uint16Array(result.vertices),
                indices : new Uint16Array(result.indices),
                minimumHeight : result.minimumHeight,
                maximumHeight : result.maximumHeight,
                boundingSphere : BoundingSphere.clone(result.boundingSphere),
                horizonOcclusionPoint : Cartesian3.clone(result.horizonOcclusionPoint),
                westIndices : result.westIndices,
                southIndices : result.southIndices,
                eastIndices : result.eastIndices,
                northIndices : result.northIndices,
                westSkirtHeight : westSkirtHeight,
                southSkirtHeight : southSkirtHeight,
                eastSkirtHeight : eastSkirtHeight,
                northSkirtHeight : northSkirtHeight,
                childTileMask : 0,
                createdByUpsampling : true
            });
        });
    };

    /**
     * Computes the terrain height at a specified longitude and latitude.
     *
     * @memberof HeightmapTerrainData
     *
     * @param {Extent} extent The extent covered by this terrain data.
     * @param {Number} longitude The longitude in radians.
     * @param {Number} latitude The latitude in radians.
     * @returns {Number} The terrain height at the specified position.  If the position
     *          is outside the extent, this method will extrapolate the height, which is likely to be wildly
     *          incorrect for positions far outside the extent.
     */
    MeshTerrainData.prototype.interpolateHeight = function(extent, longitude, latitude) {
        //var width = this._width;
        //var height = this._height;

        var heightSample = 0.0;

        var structure = this._structure;
        var stride = structure.stride;
        if (stride > 1) {
            //var elementsPerHeight = structure.elementsPerHeight;
            //var elementMultiplier = structure.elementMultiplier;
            //var isBigEndian = structure.isBigEndian;

//            heightSample = interpolateHeightWithStride(this._buffer, elementsPerHeight, elementMultiplier, stride, isBigEndian, extent, width, height, longitude, latitude);
        } else {
//            heightSample = interpolateHeight(this._buffer, extent, width, height, longitude, latitude);
        }

        return heightSample * structure.heightScale + structure.heightOffset;
    };

    /**
     * Determines if a given child tile is available, based on the
     * {@link HeightmapTerrainData.childTileMask}.  The given child tile coordinates are assumed
     * to be one of the four children of this tile.  If non-child tile coordinates are
     * given, the availability of the southeast child tile is returned.
     *
     * @memberof HeightmapTerrainData
     *
     * @param {Number} thisX The tile X coordinate of this (the parent) tile.
     * @param {Number} thisY The tile Y coordinate of this (the parent) tile.
     * @param {Number} childX The tile X coordinate of the child tile to check for availability.
     * @param {Number} childY The tile Y coordinate of the child tile to check for availability.
     * @returns {Boolean} True if the child tile is available; otherwise, false.
     */
    MeshTerrainData.prototype.isChildAvailable = function(thisX, thisY, childX, childY) {
        if (typeof thisX === 'undefined') {
            throw new DeveloperError('thisX is required.');
        }
        if (typeof thisY === 'undefined') {
            throw new DeveloperError('thisY is required.');
        }
        if (typeof childX === 'undefined') {
            throw new DeveloperError('childX is required.');
        }
        if (typeof childY === 'undefined') {
            throw new DeveloperError('childY is required.');
        }

        var bitNumber = 2; // northwest child
        if (childX !== thisX * 2) {
            ++bitNumber; // east child
        }
        if (childY !== thisY * 2) {
            bitNumber -= 2; // south child
        }

        return (this._childTileMask & (1 << bitNumber)) !== 0;
    };

    /**
     * Gets the water mask included in this terrain data, if any.  A water mask is a rectangular
     * Uint8Array or image where a value of 255 indicates water and a value of 0 indicates land.
     * Values in between 0 and 255 are allowed as well to smoothly blend between land and water.
     *
     *  @memberof HeightmapTerrainData
     *
     *  @returns {Uint8Array|Image|Canvas} The water mask, or undefined if no water mask is associated with this terrain data.
     */
    MeshTerrainData.prototype.getWaterMask = function() {
        return this._waterMask;
    };

    /**
     * Gets a value indicating whether or not this terrain data was created by upsampling lower resolution
     * terrain data.  If this value is false, the data was obtained from some other source, such
     * as by downloading it from a remote server.  This method should return true for instances
     * returned from a call to {@link HeightmapTerrainData#upsample}.
     *
     * @memberof HeightmapTerrainData
     *
     * @returns {Boolean} True if this instance was created by upsampling; otherwise, false.
     */
    MeshTerrainData.prototype.wasCreatedByUpsampling = function() {
        return this._createdByUpsampling;
    };

    return MeshTerrainData;
});