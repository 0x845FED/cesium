#ifdef INSTANCED
attribute vec2 direction;
#endif
attribute vec4 positionHighAndScaleX;
attribute vec4 positionLowAndScaleY;
attribute vec4 compressedAttribute;

varying vec2 v_textureCoordinates;
varying vec2 v_scale;
varying vec3 v_positionHigh;
varying vec3 v_positionLow;
varying vec3 v_position;
void main() {
    // Unpack attributes.
    vec3 positionHigh = positionHighAndScaleX.xyz;
    vec3 positionLow = positionLowAndScaleY.xyz;
    vec2 scale = vec2(positionHighAndScaleX.w, positionLowAndScaleY.w);
    float show = compressedAttribute.x;
    float flatCloud = compressedAttribute.y;
    vec2 textureCoordinates = compressedAttribute.wz;
    
#ifdef INSTANCED
    vec2 dir = direction;
#else
    vec2 dir = textureCoordinates;
#endif
    vec2 offset = dir - vec2(0.5, 0.5);
    vec2 scaledOffset = scale * offset;
    vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
    vec4 positionEC = czm_modelViewRelativeToEye * p;
    positionEC.xy += scaledOffset;
    positionEC.xyz *= show;

    gl_Position = czm_projection * positionEC;

    v_positionHigh = positionHigh;
    v_positionLow = positionLow;
    v_position = positionEC.xyz;
    v_textureCoordinates = offset;
    v_scale = scale;
}