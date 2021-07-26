import { GltfLoader, Resource } from "../../Source/Cesium.js";
import { ModelExperimental } from "../../Source/Cesium.js";
import createScene from "../createScene.js";

describe("Scene/ModelExperimental", function () {
  var boxTexturedGlbUrl =
    "./Data/Models/GltfLoader/BoxTextured/glTF-Binary/BoxTextured.glb";

  var scene;

  beforeAll(function () {
    scene = createScene();
  });

  it("initializes from Uint8Array", function () {
    spyOn(GltfLoader.prototype, "load");

    var resource = Resource.createIfNeeded(boxTexturedGlbUrl);
    var loadPromise = resource.fetchArrayBuffer();
    return loadPromise.then(function (buffer) {
      var model = new ModelExperimental({
        gltf: new Uint8Array(buffer),
      });

      expect(GltfLoader.prototype.load).toHaveBeenCalled();
      model._readyPromise.then(function () {
        expect(model._sceneGraph).toBeDefined();
        expect(model._resourcesLoaded).toEqual(true);
      });
    });
  });
});
