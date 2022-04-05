/*
Don't delete this comment!
Some shader code is dynamically generated in VoxelPrimitive.js to support custom shaders with arbitrary metadata.
Below is an example of how this code might look. Properties like "temperature" and "direction" are just examples.

// Defines
#define PROPERTY_COUNT ###
#define SAMPLE_COUNT ###
#define SHAPE_BOX
#define SHAPE_ELLIPSOID
#define SHAPE_CYLINDER
#define SHAPE_INTERSECTION_COUNT ###
#define MEGATEXTURE_2D
#define MEGATEXTURE_3D
#define DEPTH_TEST
#define JITTER
#define NEAREST_SAMPLING
#define DESPECKLE
#define STATISTICS
#define PADDING
#define BOUNDS
#define CLIPPING_BOUNDS
#define PICKING

// Uniforms
uniform sampler2D u_megatextureTextures[PROPERTY_COUNT];

// Structs
struct PropertyStatistics_temperature {
    float min;
    float max;
};
struct PropertyStatistics_direction {
    vec3 min;
    vec3 max;
};
struct Statistics {
    PropertyStatistics_temperature temperature;
    PropertyStatistics_direction direction;
};
struct Metadata {
    Statistics statistics;
    float temperature;
    vec3 direction;
};
struct VoxelProperty_temperature {
    vec3 partialDerivativeLocal;
    vec3 partialDerivativeWorld;
    vec3 partialDerivativeView;
    bool partialDerivativeValid;
};
struct VoxelProperty_direction {
    mat3 partialDerivativeLocal;
    mat3 partialDerivativeWorld;
    mat3 partialDerivativeView;
    bool partialDerivativeValid;
};
struct Voxel {
    VoxelProperty_temperature temperature;
    VoxelProperty_direction direction;
    vec3 positionEC;
    vec3 positionUv;
    vec3 positionUvShapeSpace;
    vec3 positionUvLocal;
    vec3 viewDirUv;
    vec3 viewDirWorld;
    float travelDistance;
};
struct FragmentInput {
    Metadata metadata;
    Voxel voxel;
};
struct Properties {
    // This struct is similar to Metadata but is not part of the custom shader API and
    // is intended to be used internally as a lightweight way to pass around properties.
    float temperature;
    vec3 direction;
};

// Functions
Properties clearProperties() {
    Properties properties;
    properties.temperature = 0.0;
    properties.direction = vec3(0.0);
    return properties;
}
Properties sumProperties(Properties propertiesA, Properties propertiesB) {
    Properties properties;
    properties.temperature = propertiesA.temperature + propertiesB.temperature;
    properties.direction = propertiesA.direction + propertiesB.direction;
    return properties;
}
Properties mixProperties(Properties propertiesA, Properties propertiesB, float mixFactor) {
    Properties properties;
    properties.temperature = mix(propertiesA.temperature, propertiesB.temperature, mixFactor);
    properties.direction = mix(propertiesA.direction, propertiesB.direction, mixFactor);
    return properties;
}
void copyPropertiesToMetadata(in Properties properties, inout Metadata metadata) {
    metadata.temperature = properties.temperature;
    metadata.direction = properties.direction;
}
void setStatistics(inout Statistics statistics) {
    // Assume the "direction" property has no min/max 
    statistics.temperature.min = 20.0;
    statistics.temperature.max = 50.0;
}
Properties getPropertiesFrom2DMegatextureAtUv(vec2 texcoord) {
    Properties properties;
    properties.temperature = texture2D(u_megatextureTextures[0], texcoord).r;
    properties.direction = texture2D(u_megatextureTextures[1], texcoord).rgb;
    return properties;
}
Properties getPropertiesFrom3DMegatextureAtUv(vec3 texcoord) {
    Properties properties;
    properties.temperature = texture3D(u_megatextureTextures[0], texcoord).r;
    properties.direction = texture3D(u_megatextureTextures[1], texcoord).rgb;
    return properties;
}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 direction = fsInput.metadata.direction;
    float temperature = fsInput.metadata.temperature;
    float minTemperature = fsInput.metadata.statistics.temperature.min;
    float maxTemperature = fsInput.metadata.statistics.temperature.max;
    
    material.diffuse = abs(direction);
    material.alpha = (temperature - minTemperature) / (maxTemperature - minTemperature);
}
*/

// These octree flags must be in sync with GpuOctreeFlag in VoxelTraversal.js
#define OCTREE_FLAG_INTERNAL 0
#define OCTREE_FLAG_LEAF 1
#define OCTREE_FLAG_PACKED_LEAF_FROM_PARENT 2

#define STEP_COUNT_MAX 1000 // Harcoded value because GLSL doesn't like variable length loops
#define OCTREE_MAX_LEVELS 32 // Harcoded value because GLSL doesn't like variable length loops
#define ALPHA_ACCUM_MAX 0.98 // Must be > 0.0 and <= 1.0

#if defined(MEGATEXTURE_2D)
uniform ivec2 u_megatextureSliceDimensions; // number of slices per tile, in two dimensions
uniform ivec2 u_megatextureTileDimensions; // number of tiles per megatexture, in two dimensions
uniform vec2 u_megatextureVoxelSizeUv;
uniform vec2 u_megatextureSliceSizeUv;
uniform vec2 u_megatextureTileSizeUv;
#endif

uniform ivec3 u_dimensions; // does not include padding
#if defined(PADDING)
uniform ivec3 u_paddingBefore;
uniform ivec3 u_paddingAfter;
#endif

uniform sampler2D u_octreeInternalNodeTexture;
uniform vec2 u_octreeInternalNodeTexelSizeUv;
uniform int u_octreeInternalNodeTilesPerRow;
uniform sampler2D u_octreeLeafNodeTexture;
uniform vec2 u_octreeLeafNodeTexelSizeUv;
uniform int u_octreeLeafNodeTilesPerRow;

uniform mat4 u_transformPositionViewToUv;
uniform mat4 u_transformPositionUvToView;
uniform mat3 u_transformDirectionViewToLocal;
uniform mat3 u_transformNormalLocalToWorld;
uniform vec3 u_cameraPositionUv;
uniform float u_stepSize;

#if defined(BOUNDS)
uniform vec3 u_minBounds; // Bounds from the voxel primitive
uniform vec3 u_maxBounds; // Bounds from the voxel primitive
uniform vec3 u_minBoundsUv; // Similar to u_minBounds but relative to UV space [0,1]
uniform vec3 u_maxBoundsUv; // Similar to u_maxBounds but relative to UV space [0,1]
uniform vec3 u_inverseBounds; // Equal to 1.0 / (u_maxBounds - u_minBounds)
uniform vec3 u_inverseBoundsUv; // Equal to 1.0 / (u_maxBoundsUv - u_minBoundsUv)
#endif

#if defined(CLIPPING_BOUNDS)
uniform vec3 u_minClippingBounds;
uniform vec3 u_maxClippingBounds;
#endif

#if defined(SHAPE_ELLIPSOID)
uniform float u_ellipsoidInverseHeightDifferenceUv;
uniform vec3 u_ellipsoidOuterRadiiLocal; // [0,1]
uniform vec3 u_ellipsoidInverseRadiiSquaredLocal;
#endif

#if defined(PICKING)
uniform vec4 u_pickColor;
#endif

struct OctreeNodeData {
    int data;
    int flag;
};

struct SampleData {
   int megatextureIndex;
   int levelsAbove;
   #if (SAMPLE_COUNT > 1)
   float weight;
   #endif
};

// --------------------------------------------------------
// Misc math
// --------------------------------------------------------

#if defined(JITTER)
#define HASHSCALE 50.0
float hash(vec2 p)
{
	vec3 p3 = fract(vec3(p.xyx) * HASHSCALE);
	p3 += dot(p3, p3.yzx + 19.19);
	return fract((p3.x + p3.y) * p3.z);
}
#endif

int intMod(int a, int b) {
    return a - (b * (a / b));
}
int intMin(int a, int b) {
    return a <= b ? a : b;
}
int intMax(int a, int b) {
    return a >= b ? a : b;
}
int intClamp(int v, int minVal, int maxVal) {
    return intMin(intMax(v, minVal), maxVal);
}
float safeMod(float a, float m) {
    return mod(mod(a, m) + m, m);
}
bool inRange(float v, float minVal, float maxVal) {
    return clamp(v, minVal, maxVal) == v;
}
bool inRange(vec3 v, vec3 minVal, vec3 maxVal) {
    return clamp(v, minVal, maxVal) == v;
}
int normU8_toInt(float value) {
    return int(value * 255.0);
}
int normU8x2_toInt(vec2 value) {
    return int(value.x * 255.0) + 256 * int(value.y * 255.0);
}
float normU8x2_toFloat(vec2 value) {
    return float(normU8x2_toInt(value)) / 65535.0;
}
vec2 index1DTo2DTexcoord(int index, ivec2 dimensions, vec2 uvScale)
{
    int indexX = intMod(index, dimensions.x);
    int indexY = index / dimensions.x;
    return vec2(indexX, indexY) * uvScale;
}

// --------------------------------------------------------
// Intersection tests, shape coordinate conversions, etc
// --------------------------------------------------------

struct Ray
{
    vec3 pos;
    vec3 dir;
};

const float NoHit = -czm_infinity;
const float InfHit = czm_infinity;

#if (defined(SHAPE_CYLINDER) && defined(BOUNDS)) || (defined(SHAPE_ELLIPSOID) && defined(BOUNDS))
vec2 resolveIntersections(vec2 intersections[SHAPE_INTERSECTION_COUNT])
{
    // TODO: completely skip shape if both of its Ts are below 0.0?
    vec2 entryExitT = vec2(NoHit, NoHit);

    // Sort the intersections from min T to max T with bubble sort.
    // Note: If this sorting function changes, some of the intersection test may
    // need to be updated. Search for "bubble sort" to find those areas.

    const int sortPasses = SHAPE_INTERSECTION_COUNT - 1;
    for (int n = sortPasses; n > 0; --n)
    {
        for (int i = 0; i < sortPasses; ++i)
        {
            // The loop should be: for (i = 0; i < n; ++i) {...} but WebGL1 cannot
            // loop with non-constant condition, so it has to break early instead
            if (i >= n) { break; }
            
            vec2 intersect0 = intersections[i];
            vec2 intersect1 = intersections[i+1];

            float idx0 = intersect0.x;
            float idx1 = intersect1.x;
            float t0 = intersect0.y;
            float t1 = intersect1.y;

            float tmin = min(t0, t1);
            float tmax = max(t0, t1);
            float idxmin = tmin == t0 ? idx0 : idx1;
            float idxmax = tmin == t0 ? idx1 : idx0;

            intersections[i] = vec2(idxmin, tmin);
            intersections[i+1] = vec2(idxmax, tmax);            
        }
    }
        
    int surroundCount = 0;
    bool surroundIsPositive = false; 
    for (int i = 0; i < SHAPE_INTERSECTION_COUNT; i++)
    {
        vec2 entry = intersections[i];
        float idx = entry.x;
        float t = entry.y;

        bool currShapeIsPositive = idx <= 1.0;
        bool enter = mod(idx, 2.0) == 0.0;

        surroundCount += enter ? +1 : -1;
        surroundIsPositive = currShapeIsPositive ? enter : surroundIsPositive;
        
        // entering positive or exiting negative
        if (surroundCount == 1 && surroundIsPositive && enter == currShapeIsPositive) {
            entryExitT.x = t;
        }
        
        // exiting positive or entering negative after being inside positive
        // TODO: Can this be simplified?
        if ((!enter && currShapeIsPositive && surroundCount == 0) || (enter && !currShapeIsPositive && surroundCount == 2 && surroundIsPositive)) {
            entryExitT.y = t;

            // entry and exit have been found, so the loop can stop
            break;
        }
    }
    return entryExitT;
}
#endif

#if defined(SHAPE_BOX)
// Unit cube from [-1, +1]
vec2 intersectUnitCube(Ray ray)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
                
    vec3 dInv = 1.0 / d;
    vec3 od = -o * dInv;
    vec3 t0 = od - dInv;
    vec3 t1 = od + dInv;
    vec3 m0 = min(t0, t1);
    vec3 m1 = max(t0, t1);
    float tMin = max(max(m0.x, m0.y), m0.z);
    float tMax = min(min(m1.x, m1.y), m1.z);
    
    if (tMin >= tMax) {
        return vec2(NoHit, NoHit);
    }

    return vec2(tMin, tMax);
}
#endif

#if defined(SHAPE_BOX)
vec2 intersectUnitSquare(Ray ray) // Unit square from [-1, +1]
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;

    float t = -o.z / d.z;
    vec2 planePos = o.xy + d.xy * t;
    if (any(greaterThan(abs(planePos), vec2(1.0)))) {
        return vec2(NoHit, NoHit);
    }

    return vec2(t, t);
}
#endif

#if defined(SHAPE_BOX)
vec2 intersectBoxShape(Ray ray)
{
    #if defined(BOUNDS)
        vec3 pos = 0.5 * (u_minBounds + u_maxBounds);
        vec3 scale = 0.5 * (u_maxBounds - u_minBounds);
        
        if (any(equal(scale, vec3(0.0)))) {
            // Transform the ray into unit space on Z plane
            Ray flatRay;
            if (scale.x == 0.0) {
                flatRay = Ray(
                    (ray.pos.yzx - pos.yzx) / vec3(scale.yz, 1.0),
                    ray.dir.yzx / vec3(scale.yz, 1.0)
                );
            } else if (scale.y == 0.0) {
                flatRay = Ray(
                    (ray.pos.xzy - pos.xzy) / vec3(scale.xz, 1.0),
                    ray.dir.xzy / vec3(scale.xz, 1.0)
                );
            } else if (scale.z == 0.0) {
                flatRay = Ray(
                    (ray.pos.xyz - pos.xyz) / vec3(scale.xy, 1.0),
                    ray.dir.xyz / vec3(scale.xy, 1.0)
                );
            }
            return intersectUnitSquare(flatRay);
        } else {
            // Transform the ray into "unit space"
            Ray unitRay = Ray((ray.pos - pos) / scale, ray.dir / scale);
            return intersectUnitCube(unitRay);
        }
    #else
        return intersectUnitCube(ray);
    #endif
}
#endif

#if (defined(SHAPE_CYLINDER) && (defined(BOUNDS_2_MIN) || defined(BOUNDS_2_MAX))) || (defined(SHAPE_ELLIPSOID) && (defined(BOUNDS_0_MIN) || defined(BOUNDS_0_MAX)))
vec2 intersectWedge(Ray ray, float minAngle, float maxAngle)
{    
    vec2 o = ray.pos.xy;
    vec2 d = ray.dir.xy;
    vec2 n1 = vec2(sin(minAngle), -cos(minAngle));
    vec2 n2 = vec2(-sin(maxAngle), cos(maxAngle));
    
    float a1 = dot(o, n1);
    float a2 = dot(o, n2);
    float b1 = dot(d, n1);
    float b2 = dot(d, n2);
    
    float t1 = -a1 / b1;
    float t2 = -a2 / b2;
    float s1 = sign(a1);
    float s2 = sign(a2);

    float tmin = min(t1, t2);
    float tmax = max(t1, t2);
    float smin = tmin == t1 ? s1 : s2;
    float smax = tmin == t1 ? s2 : s1;    
    
    bool e = tmin >= 0.0;
    bool f = tmax >= 0.0;
    bool g = smin >= 0.0;
    bool h = smax >= 0.0;

    // if () return vec2(tmin, tmax);
    // else if () return vec2(NoHitNeg, tmin);
    // else if () return vec2(NoHitNeg, tmax);
    // else if () return vec2(tmax, NoHitPos);
    // else return vec2(NoHit, NoHit);

    if (e != g && f == h) return vec2(tmin, tmax);
    else if (e == g && f == h) return vec2(-InfHit, tmin);
    else if (e != g && f != h) return vec2(tmax, +InfHit);
    else return vec2(NoHit, NoHit);
}
#endif

#if defined(SHAPE_CYLINDER)
vec2 intersectUnitCylinder(Ray ray)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    
    float a = dot(d.xy, d.xy);
    float b = dot(o.xy, d.xy);
    float c = dot(o.xy, o.xy) - 1.0;
    float det = b * b - a * c;
    
    if (det < 0.0) {
        return vec2(NoHit, NoHit);
    }
    
    det = sqrt(det);
    float ta = (-b - det) / a;
    float tb = (-b + det) / a;
    float t1 = min(ta, tb);
    float t2 = max(ta, tb);
    
    float z1 = o.z + t1 * d.z;
    float z2 = o.z + t2 * d.z;
    
    if (abs(z1) >= 1.0)
    {
        float tCap = (sign(z1) - o.z) / d.z;
        t1 = abs(b + a * tCap) < det ? tCap : NoHit;
    }
    
    if (abs(z2) >= 1.0)
    {
        float tCap = (sign(z2) - o.z) / d.z;
        t2 = abs(b + a * tCap) < det ? tCap : NoHit;
    }
    
    return vec2(t1, t2);
}
#endif

#if defined(SHAPE_CYLINDER)
vec2 intersectUnitCircle(Ray ray) {
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    
    float t = -o.z / d.z;
    vec2 zPlanePos = o.xy + d.xy * t;
    float distSqr = dot(zPlanePos, zPlanePos);

    if (distSqr > 1.0) {
        return vec2(NoHit, NoHit);
    }
    
    return vec2(t, t);
}
#endif

#if defined(SHAPE_CYLINDER) && defined(BOUNDS_0_MIN)
vec2 intersectInfiniteUnitCylinder(Ray ray)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    
    float a = dot(d.xy, d.xy);
    float b = dot(o.xy, d.xy);
    float c = dot(o.xy, o.xy) - 1.0;
    float det = b * b - a * c;
    
    if (det < 0.0) {
        return vec2(NoHit, NoHit);
    }
    
    det = sqrt(det);
    float t1 = (-b - det) / a;
    float t2 = (-b + det) / a;
    float tmin = min(t1, t2);
    float tmax = max(t1, t2);

    return vec2(tmin, tmax);
}
#endif

#if defined(SHAPE_CYLINDER)
vec2 intersectCylinderShape(Ray ray)
{
    #if !defined(BOUNDS)
        return intersectUnitCylinder(ray);
    #else
        float minRadius = u_minBounds.x; // [0,1]
        float maxRadius = u_maxBounds.x; // [0,1]
        float minHeight = u_minBounds.y; // [-1,+1]
        float maxHeight = u_maxBounds.y; // [-1,+1]
        float minAngle = u_minBounds.z; // [-pi,+pi]
        float maxAngle = u_maxBounds.z; // [-pi,+pi]

        float posZ = 0.5 * (minHeight + maxHeight);
        vec3 pos = vec3(0.0, 0.0, posZ);
        float scaleZ = 0.5 * (maxHeight - minHeight);
        
        vec2 outerIntersect;

        // TODO: use define instead of branch
        if (scaleZ == 0.0) {
            vec3 outerScale = vec3(maxRadius, maxRadius, 1.0);
            Ray outerRay = Ray((ray.pos - pos) / outerScale, ray.dir / outerScale);    
            outerIntersect = intersectUnitCircle(outerRay);
        } else {
            vec3 outerScale = vec3(maxRadius, maxRadius, scaleZ);
            Ray outerRay = Ray((ray.pos - pos) / outerScale, ray.dir / outerScale);    
            outerIntersect = intersectUnitCylinder(outerRay);
        }

        if (outerIntersect == vec2(NoHit, NoHit)) {
            return vec2(NoHit, NoHit);
        }

        vec2 intersections[SHAPE_INTERSECTION_COUNT];
        intersections[0] = vec2(float(0), outerIntersect.x);
        intersections[1] = vec2(float(1), outerIntersect.y);
        
        #if defined(BOUNDS_0_MIN)
            vec3 innerScale = vec3(minRadius, minRadius, 1.0);
            Ray innerRay = Ray((ray.pos - pos) / innerScale, ray.dir / innerScale);
            vec2 innerIntersect = intersectInfiniteUnitCylinder(innerRay);

            // TODO: use define instead of branch
            if (minRadius != maxRadius) {
                intersections[2] = vec2(float(2), innerIntersect.x);
                intersections[3] = vec2(float(3), innerIntersect.y);
            } else {            
                // When the cylinder is perfectly thin it's necessary to sandwich the
                // inner cylinder intersection inside the outer cylinder intersection.
                
                // Without this special case,
                // [outerMin, outerMax, innerMin, innerMax] will bubble sort to
                // [outerMin, innerMin, outerMax, innerMax] which will cause the back
                // side of the cylinder to be invisible because it will think the ray
                // is still inside the inner (negative) cylinder after exiting the
                // outer (positive) cylinder. 

                // With this special case,
                // [outerMin, innerMin, innerMax, outerMax] will bubble sort to
                // [outerMin, innerMin, innerMax, outerMax] which will work correctly.

                // Note: If resolveIntersections() changes its sorting function
                // from bubble sort to something else, this code may need to change.

                intersections[0] = vec2(float(0), outerIntersect.x);
                intersections[1] = vec2(float(2), innerIntersect.x);
                intersections[2] = vec2(float(3), innerIntersect.y);
                intersections[3] = vec2(float(1), outerIntersect.y);        
            }
        #endif

        #if defined(BOUNDS_2_MIN) || defined(BOUNDS_2_MAX)
            vec2 wedgeIntersect = intersectWedge(ray, minAngle, maxAngle);
            intersections[BOUNDS_2_MIN_MAX_IDX * 2 + 0] = vec2(float(BOUNDS_2_MIN_MAX_IDX * 2 + 0), wedgeIntersect.x);
            intersections[BOUNDS_2_MIN_MAX_IDX * 2 + 1] = vec2(float(BOUNDS_2_MIN_MAX_IDX * 2 + 1), wedgeIntersect.y);
        #endif
        
        return resolveIntersections(intersections);
    #endif
}
#endif

#if defined(SHAPE_ELLIPSOID)
vec2 intersectUnitSphere(Ray ray)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    
    float b = dot(d, o);
    float c = dot(o, o) - 1.0;
    float det = b * b - c;
    
    if (det < 0.0) {
        return vec2(NoHit, NoHit);
    }
    
    det = sqrt(det);
    float t1 = -b - det;
    float t2 = -b + det;
    float tmin = min(t1, t2);
    float tmax = max(t1, t2);
    
    return vec2(tmin, tmax);
}
#endif

#if defined(SHAPE_ELLIPSOID)
vec2 intersectUnitSphereUnnormalizedDirection(Ray ray)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    
    float a = dot(d, d);
    float b = dot(d, o);
    float c = dot(o, o) - 1.0;
    float det = b * b - a * c;
    
    if (det < 0.0) {
        return vec2(NoHit, NoHit);
    }
    
    det = sqrt(det);
    float t1 = (-b - det) / a;
    float t2 = (-b + det) / a;
    float tmin = min(t1, t2);
    float tmax = max(t1, t2);
    
    return vec2(tmin, tmax);
}
#endif

#if defined(SHAPE_ELLIPSOID) && (defined(BOUNDS_1_MIN) || defined(BOUNDS_1_MAX))
// TODO: can angle and direction be folded into the same parameter
vec2 intersectUncappedCone(Ray ray, float angle, float direction)
{
    vec3 o = ray.pos;
    vec3 d = ray.dir;
    float s = direction;
    float h = max(0.01, angle); // float fix
    
    float hh = h * h;
    float ds = d[2] * s;
    float os = o[2] * s;
    float od = dot(o, d);
    float oo = dot(o, o);
    
    float a = ds * ds - hh;
    float b = ds * os - od * hh;
    float c = os * os - oo * hh;
    float det = b * b - a * c;
    
    if (det < 0.0) {
        return vec2(NoHit, NoHit);
    }
    
    det = sqrt(det);
    float t1 = (-b - det) / a;
    float t2 = (-b + det) / a;
    float tmin = min(t1, t2);
    float tmax = max(t1, t2);

    float h1 = (o[2] + tmin * d[2]) * s;
    float h2 = (o[2] + tmax * d[2]) * s;
 
    if (h1 < 0.0 && h2 < 0.0) {
        return vec2(NoHit, NoHit);
    }

    else if (h1 < 0.0) return vec2(tmax, NoHitPos);
    else if (h2 < 0.0) return vec2(NoHitNeg, tmin);
    else return vec2(tmin, tmax);
}
#endif

#if defined(SHAPE_ELLIPSOID)
vec2 intersectEllipsoidShape(Ray ray)
{
    #if !defined(BOUNDS)
        return intersectUnitSphereUnnormalizedDirection(ray);
    #else
        float lonMin = u_minBounds.x; // [-pi,+pi]
        float lonMax = u_maxBounds.x; // [-pi,+pi]
        float latMin = u_minBounds.y; // [-halfPi,+halfPi]
        float latMax = u_maxBounds.y; // [-halfPi,+halfPi]
        float heightMin = u_minBounds.z; // [-inf,+inf]
        float heightMax = u_maxBounds.z; // [-inf,+inf]
        
        vec2 outerIntersect = intersectUnitSphere(ray);
        if (outerIntersect == vec2(NoHit, NoHit)) {
            return vec2(NoHit, NoHit);
        }
        
        float intersections[SHAPE_INTERSECTION_COUNT];
        intersections[BOUNDS_2_MAX_IDX * 2 + 0] = outerIntersect.x;
        intersections[BOUNDS_2_MAX_IDX * 2 + 1] = outerIntersect.y;
        
        #if defined(BOUNDS_2_MIN)
            float innerScale = heightMin;
            Ray innerRay = Ray(ray.pos / innerScale, ray.dir / innerScale);
            vec2 innerIntersect = intersectUnitSphereUnnormalizedDirection(innerRay);
            intersections[BOUNDS_2_MIN_IDX * 2 + 0] = innerIntersect.x;
            intersections[BOUNDS_2_MIN_IDX * 2 + 1] = innerIntersect.y;
        #endif
            
        #if defined(BOUNDS_1_MIN)
            vec2 botConeIntersect = intersectUncappedCone(ray, abs(latMin), sign(latMin));
            intersections[BOUNDS_1_MIN_IDX * 2 + 0] = botConeIntersect.x;
            intersections[BOUNDS_1_MIN_IDX * 2 + 1] = botConeIntersect.y;
        #endif
        
        #if defined(BOUNDS_1_MAX)
            vec2 topConeIntersect = intersectUncappedCone(ray, abs(latMax), sign(latMax));
            intersections[BOUNDS_1_MAX_IDX * 2 + 0] = topConeIntersect.x;
            intersections[BOUNDS_1_MAX_IDX * 2 + 1] = topConeIntersect.y;
        #endif
        
        #if defined(BOUNDS_0_MIN) || defined(BOUNDS_0_MAX)
            vec3 planeNormal1 = -vec3(cos(lonMin), sin(lonMin), 0.0);
            vec3 planeNormal2 = vec3(cos(lonMax), sin(lonMax), 0.0);
            vec2 wedgeIntersect = intersectWedge(ray, planeNormal1, planeNormal2);
            intersections[BOUNDS_0_MIN_MAX_IDX * 2 + 0] = wedgeIntersect.x;
            intersections[BOUNDS_0_MIN_MAX_IDX * 2 + 1] = wedgeIntersect.y;
        #endif
        
        return resolveIntersections(intersections);   
    #endif
}
#endif

#if defined(SHAPE_ELLIPSOID)
// robust iterative solution without trig functions
// https://github.com/0xfaded/ellipse_demo/issues/1
// https://stackoverflow.com/questions/22959698/distance-from-given-point-to-given-ellipse

float ellipseDistanceIterative (vec2 p, in vec2 ab) {
    float px = abs(p[0]);
    float py = abs(p[1]);

    float tx = 0.707;
    float ty = 0.707;

    float a = ab.x;
    float b = ab.y;

    for (int i = 0; i < 3; i++) {
        float x = a * tx;
        float y = b * ty;

        float ex = (a*a - b*b) * pow(tx, 3.0) / a;
        float ey = (b*b - a*a) * pow(ty, 3.0) / b;

        float rx = x - ex;
        float ry = y - ey;

        float qx = px - ex;
        float qy = py - ey;

        float r = sqrt(ry * ry + rx * rx);
        float q = sqrt(qy * qy + qx * qx);

        tx = clamp((qx * r / q + ex) / a, 0.0, 1.0);
        ty = clamp((qy * r / q + ey) / b, 0.0, 1.0);
        float t = sqrt(ty * ty + tx * tx);
        tx /= t;
        ty /= t;
    }

    float cX = a * tx;
    float cY = b * ty;
    vec2 pos = vec2(cX * sign(p[0]), cY * sign(p[1]));
    return length(pos - p) * sign(py - cY);
}
#endif

vec2 intersectShape(vec3 positionUv, vec3 directionUv) {
    // Do a ray-shape intersection to find the exact starting and ending points.
    // Position is converted from [0,1] to [-1,+1] because shape intersections assume unit space is [-1,+1].
    // Direction is scaled as well to be in sync with position. 
    Ray ray = Ray(positionUv * 2.0 - 1.0, directionUv * 2.0);

    #if defined(SHAPE_BOX)
        vec2 entryExitT = intersectBoxShape(ray);
    #elif defined(SHAPE_CYLINDER)
        vec2 entryExitT = intersectCylinderShape(ray);
    #elif defined(SHAPE_ELLIPSOID)
        vec2 entryExitT = intersectEllipsoidShape(ray);
    #endif

    if (entryExitT.x < 0.0 && entryExitT.y < 0.0) {
        // Intersection is invalid when start and end are behind the ray.
        return vec2(NoHit, NoHit);
    }

    // Set start to 0 when ray is inside the shape.
    entryExitT.x = max(entryExitT.x, 0.0);

    return entryExitT;
}

#if defined(DEPTH_TEST)
float intersectDepth(vec2 fragCoord, vec2 screenUv, vec3 viewPosUv, vec3 viewDirUv) {
    float logDepthOrDepth = czm_unpackDepth(texture2D(czm_globeDepthTexture, screenUv));
    if (logDepthOrDepth != 0.0) {
        // Calculate how far the ray must travel before it hits the depth buffer.
        vec4 eyeCoordinateDepth = czm_windowToEyeCoordinates(fragCoord, logDepthOrDepth);
        eyeCoordinateDepth /= eyeCoordinateDepth.w;
        vec3 depthPositionUv = vec3(u_transformPositionViewToUv * eyeCoordinateDepth);
        return dot(viewDirUv, depthPositionUv - viewPosUv);
    } else {
        // There's no depth at this position so set it to some really far value.
        return czm_infinity;
    }
}
#endif

#if defined(SHAPE_BOX)
vec3 transformFromUvToBoxSpace(in vec3 positionUv) {
    return positionUv;
}
#endif

#if defined(SHAPE_ELLIPSOID)
vec3 transformFromUvToEllipsoidSpace(in vec3 positionUv) {
    // 1) Convert positionUv [0,1] to unit ellipsoid space [-1,+1].
    // 2) Convert from unit ellipsoid space [-1,+1] to local space. Max ellipsoid axis has value 1, anything shorter is < 1.
    // 3) Convert 3d position to 2D point relative to ellipse (since radii.x and radii.y are assumed to be equal for WGS84).
    // 4) Find closest distance. if distance > 1, it's outside the outer shell, if distance < u_ellipsoidMinimumHeightUv, it's inside the inner shell.
    // 5) Compute geodetic surface normal.
    // 6) Compute longitude and latitude from geodetic surface normal.

    vec3 posLocal = positionUv * 2.0 - 1.0; // 1
    vec3 pos3D = posLocal * u_ellipsoidOuterRadiiLocal; // 2
    vec2 pos2D = vec2(length(pos3D.xy), pos3D.z); // 3
    float dist = ellipseDistanceIterative(pos2D, u_ellipsoidOuterRadiiLocal.xz); // 4
    dist = 1.0 + dist * u_ellipsoidInverseHeightDifferenceUv; // same as delerp(dist, -u_ellipsoidHeightDifferenceUv, 0);

    vec3 normal = normalize(pos3D * u_ellipsoidInverseRadiiSquaredLocal); // 5
    float longitude = (atan(normal.y, normal.x) + czm_pi) / czm_twoPi; // 6
    float latitude = (asin(normal.z) + czm_piOverTwo) / czm_pi; // 6

    return vec3(longitude, latitude, dist);
}
#endif

#if defined(SHAPE_CYLINDER)
vec3 transformFromUvToCylinderSpace(in vec3 positionUv) {
    vec3 positionLocal = positionUv * 2.0 - 1.0; // [-1,+1]
    float radius = length(positionLocal.xy); // [0,1]
    float height = positionUv.z; // [0,1]
    float angle = (atan(positionLocal.y, positionLocal.x) + czm_pi) / czm_twoPi; // [0,1]
    return vec3(radius, height, angle);
}
#endif

vec3 transformFromUvToShapeSpace(in vec3 positionUv) {
    #if defined(SHAPE_BOX)
        vec3 positionShape = transformFromUvToBoxSpace(positionUv);
    #elif defined(SHAPE_ELLIPSOID)
        vec3 positionShape = transformFromUvToEllipsoidSpace(positionUv);
    #elif defined(SHAPE_CYLINDER)
        vec3 positionShape = transformFromUvToCylinderSpace(positionUv);
    #endif

    #if defined(BOUNDS)
        positionShape = (positionShape - u_minBoundsUv) * u_inverseBoundsUv; // [0,1]
        // TODO: This breaks down when minBounds == maxBounds. To fix it, this
        // function would have to know if ray is intersecting the front or back of the shape
        // and set the shape space position to 1 (front) or 0 (back) accordingly.
    #endif

    return positionShape;
}


// --------------------------------------------------------
// Megatexture
// --------------------------------------------------------

// TODO: 3D megatexture has not been implemented yet
#if defined(MEGATEXTURE_3D)
Properties getPropertiesFromMegatextureAtVoxelCoord(vec3 voxelCoord, ivec3 voxelDims, int tileIndex)
{
    // Tile location
    vec3 tileUvOffset = indexToUv3d(tileIndex, u_megatextureTileDimensions, u_megatextureTileSizeUv);

    // Voxel location
    vec3 voxelUvOffset = clamp(voxelCoord, vec3(0.5), vec3(voxelDims) - vec2(0.5)) * u_megatextureVoxelSizeUv;

    // Final location in the megatexture
    vec3 uv = tileUvOffset + voxelUvOffset;

    for (int i = 0; i < PROPERTY_COUNT; i++) {
        vec4 sample = texture3D(u_megatextureTextures[i], uv);
        samples[i] = decodeTextureSample(sample);
    }
}
#elif defined(MEGATEXTURE_2D)
/*
    How is 3D data stored in a 2D megatexture?

    In this example there is only one loaded tile and it has 2x2x2 voxels (8 voxels total).
    The data is sliced by Z. The data at Z = 0 is placed in texels (0,0), (0,1), (1,0), (1,1) and
    the data at Z = 1 is placed in texels (2,0), (2,1), (3,0), (3,1).
    Note that there could be empty space in the megatexture because it's a power of two.

      0   1   2   3
    +---+---+---+---+
    |   |   |   |   | 3
    +---+---+---+---+
    |   |   |   |   | 2
    +-------+-------+
    |010|110|011|111| 1
    |--- ---|--- ---|
    |000|100|001|101| 0
    +-------+-------+

    When doing linear interpolation the megatexture needs to be sampled twice: once for
    the Z slice above the voxel coordinate and once for the slice below. The two slices
    are interpolated with fract(coord.z - 0.5). For example, a Z coordinate of 1.0 is
    halfway between two Z slices so the interpolation factor is 0.5. Below is a side view
    of the 3D voxel grid with voxel coordinates on the left side.

    2 +---+
      |001|
    1 +-z-+
      |000|
    0 +---+

    When doing nearest neighbor the megatexture only needs to be sampled once at the closest Z slice.
*/
Properties getPropertiesFrom2DMegatextureAtVoxelCoord(vec3 voxelCoord, ivec3 voxelDims, int tileIndex)
{
    #if defined(NEAREST_SAMPLING)
        // Round to the center of the nearest voxel
        voxelCoord = floor(voxelCoord) + vec3(0.5); 
    #endif

    // Tile location
    vec2 tileUvOffset = index1DTo2DTexcoord(tileIndex, u_megatextureTileDimensions, u_megatextureTileSizeUv);

    // Slice location
    float slice = voxelCoord.z - 0.5;
    int sliceIndex = int(floor(slice));
    int sliceIndex0 = intClamp(sliceIndex, 0, voxelDims.z - 1);
    vec2 sliceUvOffset0 = index1DTo2DTexcoord(sliceIndex0, u_megatextureSliceDimensions, u_megatextureSliceSizeUv);

    // Voxel location
    vec2 voxelUvOffset = clamp(voxelCoord.xy, vec2(0.5), vec2(voxelDims.xy) - vec2(0.5)) * u_megatextureVoxelSizeUv;

    // Final location in the megatexture
    vec2 uv0 = tileUvOffset + sliceUvOffset0 + voxelUvOffset;

    #if defined(NEAREST_SAMPLING)
        return getPropertiesFrom2DMegatextureAtUv(uv0);
    #else
        float sliceLerp = fract(slice);
        int sliceIndex1 = intMin(sliceIndex + 1, voxelDims.z - 1);
        vec2 sliceUvOffset1 = index1DTo2DTexcoord(sliceIndex1, u_megatextureSliceDimensions, u_megatextureSliceSizeUv);
        vec2 uv1 = tileUvOffset + sliceUvOffset1 + voxelUvOffset;
        Properties properties0 = getPropertiesFrom2DMegatextureAtUv(uv0);
        Properties properties1 = getPropertiesFrom2DMegatextureAtUv(uv1);
        return mixProperties(properties0, properties1, sliceLerp);
    #endif
}
#endif

Properties getPropertiesFromMegatextureAtTileUv(vec3 tileUv, int tileIndex) {
    vec3 voxelCoord = tileUv * vec3(u_dimensions);
    ivec3 dimensions = u_dimensions;

    #if defined(PADDING)
        dimensions += u_paddingBefore + u_paddingAfter;
        voxelCoord += vec3(u_paddingBefore);
    #endif

    #if defined(MEGATEXTURE_3D)
        return getPropertiesFrom3DMegatextureAtVoxelCoord(voxelCoord, dimensions, tileIndex);
    #elif defined(MEGATEXTURE_2D)
        return getPropertiesFrom2DMegatextureAtVoxelCoord(voxelCoord, dimensions, tileIndex);
    #endif
}

vec3 computeAncestorUv(vec3 positionUvLocal, int levelsAbove, ivec4 octreeCoords) {
    if (levelsAbove > 0) {
        // In some cases positionUvLocal goes outside the 0 to 1 bounds, such as when sampling neighbor voxels on the edge of a tile.
        // This needs to be handled carefully, especially for mixed resolution, or else the wrong part of the tile is read.
        // https://www.wolframalpha.com/input/?i=sign%28x%29+*+max%280%2C+%28abs%28x-0.5%29-0.5%29%29
        vec3 overflow = sign(positionUvLocal) * max(abs(positionUvLocal - vec3(0.5)) - vec3(0.5), vec3(0.0));
        positionUvLocal = clamp(positionUvLocal, vec3(0.0), vec3(1.0 - czm_epsilon6)); // epsilon to avoid fract(1) = 0 situation

        // Calcuate a new local uv relative to the ancestor tile.
        float levelsAboveFactor = 1.0 / pow(2.0, float(levelsAbove));
        positionUvLocal = fract((vec3(octreeCoords.xyz) + positionUvLocal) * levelsAboveFactor) + overflow * levelsAboveFactor;
    } else {
        positionUvLocal = clamp(positionUvLocal, vec3(0.0), vec3(1.0));
    }
    return positionUvLocal;
}

// Convert an array of mixed-resolution sample datas to a final weighted properties.
Properties getPropertiesFromMegatextureAtLocalPosition(vec3 positionUvLocal, ivec4 octreeCoords, SampleData sampleDatas[SAMPLE_COUNT]) {
    #if (SAMPLE_COUNT == 1)
        vec3 actualUv = computeAncestorUv(positionUvLocal, sampleDatas[0].levelsAbove, octreeCoords);
        return getPropertiesFromMegatextureAtTileUv(actualUv, sampleDatas[0].megatextureIndex);
    #else
        // When more than one sample is taken the accumulator needs to start at 0
        Properties properties = clearProperties();
        for (int i = 0; i < SAMPLE_COUNT; i++) {
            vec3 actualUv = computeAncestorUv(positionUvLocal, sampleDatas[i].levelsAbove, octreeCoords);
            Properties tempProperties = getPropertiesFromMegatextureAtTileUv(actualUvLocal, sampleDatas[i].megatextureIndex);        
            properties = sumProperties(properties, tempProperties)
        }
        return properties;
    #endif
}

// --------------------------------------------------------
// Tree traversal
// --------------------------------------------------------

void getOctreeLeafData(OctreeNodeData data, inout SampleData sampleDatas[SAMPLE_COUNT]) {
    #if (SAMPLE_COUNT == 1)
        sampleDatas[0].megatextureIndex = data.data;
        sampleDatas[0].levelsAbove = data.flag == OCTREE_FLAG_PACKED_LEAF_FROM_PARENT ? 1 : 0;
    #else
        int leafIndex = data.data;
        int leafNodeTexelCount = 2;
        // Adding 0.5 moves to the center of the texel
        float leafCoordXStart = float(intMod(leafIndex, u_octreeLeafNodeTilesPerRow) * leafNodeTexelCount) + 0.5;
        float leafCoordY = float(leafIndex / u_octreeLeafNodeTilesPerRow) + 0.5;

        vec2 leafUv0 = u_octreeLeafNodeTexelSizeUv * vec2(leafCoordXStart + 0.0, leafCoordY);
        vec2 leafUv1 = u_octreeLeafNodeTexelSizeUv * vec2(leafCoordXStart + 1.0, leafCoordY);
        vec4 leafData0 = texture2D(u_octreeLeafNodeTexture, leafUv0);
        vec4 leafData1 = texture2D(u_octreeLeafNodeTexture, leafUv1);

        float lerp = normU8x2_toFloat(leafData0.xy);

        sampleDatas[0].megatextureIndex = normU8x2_toInt(leafData1.xy);
        sampleDatas[1].megatextureIndex = normU8x2_toInt(leafData1.zw);
        sampleDatas[0].levelsAbove = normU8_toInt(leafData0.z);
        sampleDatas[1].levelsAbove = normU8_toInt(leafData0.w);
        sampleDatas[0].weight = 1.0 - lerp;
        sampleDatas[1].weight = lerp;
    #endif
}

OctreeNodeData getOctreeRootData() {
    vec4 rootData = texture2D(u_octreeInternalNodeTexture, vec2(0.0));
    
    OctreeNodeData data;
    data.data = normU8x2_toInt(rootData.xy);
    data.flag = normU8x2_toInt(rootData.zw);
    return data;
}

OctreeNodeData getOctreeChildData(int parentOctreeIndex, ivec3 childCoord) {
    int childIndex = childCoord.z * 4 + childCoord.y * 2 + childCoord.x;
    int octreeCoordX = intMod(parentOctreeIndex, u_octreeInternalNodeTilesPerRow) * 9 + 1 + childIndex;
    int octreeCoordY = parentOctreeIndex / u_octreeInternalNodeTilesPerRow;
    vec2 octreeUv = u_octreeInternalNodeTexelSizeUv * vec2(float(octreeCoordX) + 0.5, float(octreeCoordY) + 0.5);
    vec4 childData = texture2D(u_octreeInternalNodeTexture, octreeUv);
    
    OctreeNodeData data;
    data.data = normU8x2_toInt(childData.xy);
    data.flag = normU8x2_toInt(childData.zw);
    return data;
}

int getOctreeParentIndex(int octreeIndex) {
    int octreeCoordX = intMod(octreeIndex, u_octreeInternalNodeTilesPerRow) * 9;
    int octreeCoordY = octreeIndex / u_octreeInternalNodeTilesPerRow;
    vec2 octreeUv = u_octreeInternalNodeTexelSizeUv * vec2(float(octreeCoordX) + 0.5, float(octreeCoordY) + 0.5);
    vec4 parentData = texture2D(u_octreeInternalNodeTexture, octreeUv);
    int parentOctreeIndex = normU8x2_toInt(parentData.xy);
    return parentOctreeIndex;
}

void traverseOctreeDownwards(in vec3 positionUv, inout ivec4 octreeCoords, inout int parentOctreeIndex, out SampleData sampleDatas[SAMPLE_COUNT]) {
    float sizeAtLevel = 1.0 / pow(2.0, float(octreeCoords.w));
    vec3 start = vec3(octreeCoords.xyz) * sizeAtLevel;
    vec3 end = start + vec3(sizeAtLevel);

    for (int i = 0; i < OCTREE_MAX_LEVELS; i++) {
        // Find out which octree child contains the position
        // 0 if before center, 1 if after
        vec3 center = 0.5 * (start + end);
        vec3 childCoord = step(center, positionUv);

        // Get octree coords for the next level down
        octreeCoords.xyz = octreeCoords.xyz * 2 + ivec3(childCoord);
        octreeCoords.w += 1;

        OctreeNodeData childData = getOctreeChildData(parentOctreeIndex, ivec3(childCoord));

        if (childData.flag == OCTREE_FLAG_INTERNAL) {
            // keep going deeper
            start = mix(start, center, childCoord);
            end = mix(center, end, childCoord);
            parentOctreeIndex = childData.data;
        } else {
            getOctreeLeafData(childData, sampleDatas);
            return;
        }
    }
}

void traverseOctree(in vec3 positionUv, out vec3 positionUvShapeSpace, out vec3 positionUvLocal, out float levelStepMult, out ivec4 octreeCoords, out int parentOctreeIndex, out SampleData sampleDatas[SAMPLE_COUNT]) {
    levelStepMult = 1.0;
    octreeCoords = ivec4(0);
    parentOctreeIndex = 0;

    // TODO: is it possible for this to be out of bounds, and does it matter?
    positionUvShapeSpace = transformFromUvToShapeSpace(positionUv);
    positionUvLocal = positionUvShapeSpace;

    OctreeNodeData rootData = getOctreeRootData();
    if (rootData.flag == OCTREE_FLAG_LEAF) {
        // No child data, only the root tile has data
        getOctreeLeafData(rootData, sampleDatas);
    }
    else
    {
        traverseOctreeDownwards(positionUvShapeSpace, octreeCoords, parentOctreeIndex, sampleDatas);
        levelStepMult = 1.0 / pow(2.0, float(octreeCoords.w));
        vec3 boxStart = vec3(octreeCoords.xyz) * levelStepMult;
        positionUvLocal = (positionUvShapeSpace - boxStart) / levelStepMult;
    }
}

void traverseOctreeFromExisting(in vec3 positionUv, out vec3 positionUvShapeSpace, out vec3 positionUvLocal, inout float levelStepMult, inout ivec4 octreeCoords, inout int parentOctreeIndex, inout SampleData sampleDatas[SAMPLE_COUNT]) {
    float dimAtLevel = pow(2.0, float(octreeCoords.w));
    positionUvShapeSpace = transformFromUvToShapeSpace(positionUv);
    positionUvLocal = positionUvShapeSpace * dimAtLevel - vec3(octreeCoords.xyz);
    
    // Note: This code assumes the position is always inside the root tile.
    bool insideTile = octreeCoords.w == 0 || inRange(positionUvLocal, vec3(0.0), vec3(1.0)); 

    if (!insideTile)
    {
        // Go up tree
        for (int i = 0; i < OCTREE_MAX_LEVELS; i++)
        {
            octreeCoords.xyz /= ivec3(2);
            octreeCoords.w -= 1;
            dimAtLevel /= 2.0;

            positionUvLocal = positionUvShapeSpace * dimAtLevel - vec3(octreeCoords.xyz);
            insideTile = octreeCoords.w == 0 || inRange(positionUvLocal, vec3(0.0), vec3(1.0));
            
            if (!insideTile) {
                parentOctreeIndex = getOctreeParentIndex(parentOctreeIndex);
            } else {
                break;
            }
        }

        // Go down tree
        traverseOctreeDownwards(positionUvShapeSpace, octreeCoords, parentOctreeIndex, sampleDatas);
        levelStepMult = 1.0 / pow(2.0, float(octreeCoords.w));
        positionUvLocal = positionUvShapeSpace / levelStepMult - vec3(octreeCoords.xyz);
    }
}

void main()
{
    vec4 fragCoord = gl_FragCoord;
    vec2 screenUv = (fragCoord.xy - czm_viewport.xy) / czm_viewport.zw;
    vec4 eyeCoordinate = czm_windowToEyeCoordinates(fragCoord);
    vec3 eyeDirection = normalize(eyeCoordinate.xyz);
    vec3 viewDirWorld = normalize(czm_inverseViewRotation * eyeDirection); // normalize again just in case
    vec3 viewDirUv = normalize(u_transformDirectionViewToLocal * eyeDirection); // normalize again just in case
    vec3 viewPosUv = u_cameraPositionUv;
    vec2 entryExitT = intersectShape(viewPosUv, viewDirUv);

    // Exit early if the shape was completely missed.
    if (entryExitT == vec2(NoHit, NoHit)) {
        discard;
    }

    float currT = entryExitT.x;
    float endT = entryExitT.y;
    vec3 positionUv = viewPosUv + currT * viewDirUv;
    
    #if defined(DEPTH_TEST)
        float depthT = intersectDepth(fragCoord.xy, screenUv, viewPosUv, viewDirUv);

        // Exit early if the depth is before the start position.
        if (depthT <= currT) {
            discard;
        }
    #endif

    vec4 colorAccum = vec4(0.0);

    #if defined(DESPECKLE)
        vec4 colorAccumTemp = vec4(0.0);
        int nonZeroCount = 0;
        int nonZeroMax = 3;
    #endif

    // Traverse the tree from the start position
    vec3 positionUvShapeSpace;
    vec3 positionUvLocal;
    float levelStepMult;
    ivec4 octreeCoords;
    int parentOctreeIndex;
    SampleData sampleDatas[SAMPLE_COUNT];
    traverseOctree(positionUv, positionUvShapeSpace, positionUvLocal, levelStepMult, octreeCoords, parentOctreeIndex, sampleDatas);
    
    // Adjust the step size based on the level in the tree
    float stepT = u_stepSize * levelStepMult;

    #if defined(JITTER)
        float noise = hash(screenUv); // [0,1]
        currT += noise * stepT;
        positionUv += noise * stepT * viewDirUv;
    #endif

    FragmentInput fragmentInput;
    #if defined(STATISTICS)
        setStatistics(fragmentInput.metadata.statistics);
    #endif

    for (int stepCount = 0; stepCount < STEP_COUNT_MAX; stepCount++) {
        // Read properties from the megatexture based on the traversal state
        Properties properties = getPropertiesFromMegatextureAtLocalPosition(positionUvLocal, octreeCoords, sampleDatas);
        
        // Prepare the custom shader inputs
        copyPropertiesToMetadata(properties, fragmentInput.metadata);
        fragmentInput.voxel.positionUv = positionUv;
        fragmentInput.voxel.positionUvShapeSpace = positionUvShapeSpace;
        fragmentInput.voxel.positionUvLocal = positionUvLocal;
        fragmentInput.voxel.viewDirUv = viewDirUv;
        fragmentInput.voxel.viewDirWorld = viewDirWorld;
        fragmentInput.voxel.travelDistance = stepT;

        #if defined(STYLE_USE_POSITION_EC)
            styleInput.positionEC = vec3(u_transformPositionUvToView * vec4(positionUv, 1.0));
        #endif

        // Run the custom shader
        czm_modelMaterial materialOutput;
        fragmentMain(fragmentInput, materialOutput);

        // Sanitize the custom shader output
        vec4 color = vec4(materialOutput.diffuse, materialOutput.alpha);
        color.rgb = max(color.rgb, vec3(0.0));
        color.a = clamp(color.a, 0.0, 1.0);

        #if defined(DESPECKLE)
            if (color.a < (1.0 - ALPHA_ACCUM_MAX)) {
                float partialAlpha = float(nonZeroCount) / float(nonZeroMax);
                colorAccum.a += partialAlpha * (colorAccumTemp.a - colorAccum.a);
                colorAccum.rgb += partialAlpha * colorAccumTemp.rgb;
                colorAccumTemp = vec4(0.0);
                nonZeroCount = 0;
            } else {
                nonZeroCount++;
                if (nonZeroCount == 1) {
                    colorAccumTemp.a = colorAccum.a;
                }
                colorAccumTemp += (1.0 - colorAccumTemp.a) * vec4(color.rgb * color.a, color.a);

                if (nonZeroCount >= nonZeroMax) {
                    colorAccum.a = colorAccumTemp.a;
                    colorAccum.rgb += colorAccumTemp.rgb;
                    colorAccumTemp = vec4(0.0);
                    nonZeroCount = 0;
                }
            }
        #else
            // Pre-multiplied alpha blend
            colorAccum += (1.0 - colorAccum.a) * vec4(color.rgb * color.a, color.a);
        #endif

        // Stop traversing if the alpha has been fully saturated
        if (colorAccum.a > ALPHA_ACCUM_MAX) {
            colorAccum.a = ALPHA_ACCUM_MAX;
            break;
        }

        // Keep raymarching
        currT += stepT;
        positionUv += stepT * viewDirUv;

        // Exit early if the ray is occluded by depth texture
        #if defined(DEPTH_TEST)
            if (currT >= depthT) {
                break;
            }
        #endif

        // Do another intersection test against the shape if the ray has entered empty space
        if (currT > endT) {
            vec2 entryExitT = intersectShape(positionUv, viewDirUv);

            // Stop raymarching if it doesn't hit anything
            if (entryExitT == vec2(NoHit, NoHit)) {
                break;
            }

            currT += entryExitT.x;
            endT += entryExitT.y;
            positionUv += entryExitT.x * viewDirUv;
        }

        // Traverse the tree from the current ray position.
        // This is similar to traverseOctree but is optimized for the common
        // case where the ray is in the same tile as the previous step.
        traverseOctreeFromExisting(positionUv, positionUvShapeSpace, positionUvLocal, levelStepMult, octreeCoords, parentOctreeIndex, sampleDatas);

        // Adjust the step size based on the level in the tree
        stepT = u_stepSize * levelStepMult;
    }

    // Convert the alpha from [0,ALPHA_ACCUM_MAX] to [0,1]
    colorAccum.a /= ALPHA_ACCUM_MAX;

    #if defined(PICKING)
        // If alpha is 0.0 there is nothing to pick
        if (colorAccum.a == 0.0) {
            discard;
        }
        gl_FragColor = u_pickColor;
    #else
        gl_FragColor = colorAccum;
    #endif
}