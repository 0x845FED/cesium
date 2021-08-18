import {
  Cartesian2,
  CustomShader,
  CustomShaderMode,
  LightingModel,
  UniformType,
  VaryingType,
} from "../../../Source/Cesium.js";

describe("Scene/ModelExperimental/CustomShader", function () {
  var emptyVertexShader =
    "vec3 vertexMain(VertexInput vsInput, vec3 position){ return position; }";
  var emptyFragmentShader =
    "void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {}";

  it("constructs with default values", function () {
    var customShader = new CustomShader();

    expect(customShader.mode).toBe(CustomShaderMode.MODIFY_MATERIAL);
    expect(customShader.lightingModel).not.toBeDefined();
    expect(customShader.uniforms).toEqual({});
    expect(customShader.varyings).toEqual({});
    expect(customShader.vertexShaderText).not.toBeDefined();
    expect(customShader.fragmentShaderText).not.toBeDefined();
    expect(customShader.uniformMap).toEqual({});
  });

  it("constructs", function () {
    var customShader = new CustomShader({
      mode: CustomShaderMode.REPLACE_MATERIAL,
      lightingModel: LightingModel.PBR,
      vertexShaderText: emptyVertexShader,
      fragmentShaderText: emptyFragmentShader,
    });

    expect(customShader.mode).toBe(CustomShaderMode.REPLACE_MATERIAL);
    expect(customShader.lightingModel).toBe(LightingModel.PBR);
    expect(customShader.uniforms).toEqual({});
    expect(customShader.varyings).toEqual({});
    expect(customShader.vertexShaderText).toBe(emptyVertexShader);
    expect(customShader.fragmentShaderText).toBe(emptyFragmentShader);
    expect(customShader.uniformMap).toEqual({});
  });

  it("defines uniforms", function () {
    var uniforms = {
      u_time: {
        value: 0,
        type: UniformType.FLOAT,
      },
      u_offset: {
        value: new Cartesian2(1, 2),
        type: UniformType.VEC2,
      },
    };

    var customShader = new CustomShader({
      uniforms: uniforms,
    });

    expect(customShader.uniforms).toBe(uniforms);
    expect(customShader.uniformMap.u_time()).toBe(uniforms.u_time.value);
    expect(customShader.uniformMap.u_offset()).toBe(uniforms.u_offset.value);
  });

  it("setUniform updates uniform values", function () {
    var uniforms = {
      u_time: {
        value: 0,
        type: UniformType.FLOAT,
      },
      u_offset: {
        value: new Cartesian2(1, 2),
        type: UniformType.VEC2,
      },
    };

    var customShader = new CustomShader({
      uniforms: uniforms,
    });

    expect(customShader.uniformMap.u_time()).toBe(0);
    customShader.setUniform("u_time", 10);
    expect(customShader.uniformMap.u_time()).toBe(10);
  });

  it("declares varyings", function () {
    var varyings = {
      v_dist_from_center: VaryingType.FLOAT,
      v_computedMatrix: VaryingType.MAT4,
    };

    var customShader = new CustomShader({
      varyings: varyings,
    });

    expect(customShader.varyings).toBe(varyings);
  });
});
