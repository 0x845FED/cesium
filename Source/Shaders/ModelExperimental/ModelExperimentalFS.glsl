czm_modelMaterial defaultModelMaterial()
{
    czm_modelMaterial material;
    material.diffuse = vec3(1.0);
    material.specular = vec3(0.04); // dielectric (non-metal)
    material.roughness = 0.0;
    material.occlusion = 1.0;
    material.normal = vec3(0.0, 0.0, 1.0);
    material.emissive = vec3(0.0);
    return material;
}

vec4 handleAlpha(vec3 color, float alpha)
{
    #ifdef ALPHA_MODE_MASK
    if (alpha < u_alphaCutoff) {
        discard;
    }
    return vec4(color, 1.0);
    #elif defined(ALPHA_MODE_BLEND)
    return vec4(color, alpha);
    #else // OPAQUE
    return vec4(color, 1.0);
    #endif
}

void main() 
{
    czm_modelMaterial material = defaultModelMaterial();
    #if defined(CUSTOM_SHADER_REPLACE_MATERIAL)
    material = customShaderStage(material);
    #elif defined(CUSTOM_SHADER_BEFORE_MATERIAL)
    material = customShaderStage(material);
    material = materialStage(material);
    #elif defined(CUSTOM_SHADER_MODIFY_MATERIAL)
    material = materialStage(material);
    material = customShaderStage(material);
    #else
    material = materialStage(material);
    #endif

    material = lightingStage(material);

    #if defined(CUSTOM_SHADER_AFTER_LIGHTING)
    material = customShaderStage(material);
    #endif

    vec4 color = handleAlpha(material.diffuse, material.alpha);
    gl_FragColor = color;
}