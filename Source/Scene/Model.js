/*global define*/
define([
        '../Core/combine',
        '../Core/defined',
        '../Core/defaultValue',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/RuntimeError',
        '../Core/Enumeration',
        '../Core/loadArrayBuffer',
        '../Core/loadText',
        '../Core/loadImage',
        '../Core/Queue',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Quaternion',
        '../Core/Matrix4',
        '../Core/BoundingSphere',
        '../Core/IndexDatatype',
        '../Core/ComponentDatatype',
        '../Core/PrimitiveType',
        '../Core/Math',
        '../Core/Event',
        '../Renderer/TextureWrap',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/BufferUsage',
        '../Renderer/BlendingState',
        '../Renderer/DrawCommand',
        '../Renderer/CommandLists',
        '../Renderer/createShaderSource',
        './ModelTypes',
        './ModelCache',
        './SceneMode'
    ], function(
        combine,
        defined,
        defaultValue,
        destroyObject,
        DeveloperError,
        RuntimeError,
        Enumeration,
        loadArrayBuffer,
        loadText,
        loadImage,
        Queue,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Quaternion,
        Matrix4,
        BoundingSphere,
        IndexDatatype,
        ComponentDatatype,
        PrimitiveType,
        CesiumMath,
        Event,
        TextureWrap,
        TextureMinificationFilter,
        TextureMagnificationFilter,
        BufferUsage,
        BlendingState,
        DrawCommand,
        CommandLists,
        createShaderSource,
        ModelTypes,
        ModelCache,
        SceneMode) {
    "use strict";

    var ModelState = {
        NEEDS_LOAD : new Enumeration(0, 'NEEDS_LOAD'),
        LOADING : new Enumeration(1, 'LOADING'),
        LOADED : new Enumeration(2, 'LOADED')
    };

    function LoadResources() {
        this.bufferViewsToCreate = new Queue();
        this.buffers = {};
        this.pendingBufferLoads = 0;

        this.programsToCreate = new Queue();
        this.shaders = {};
        this.pendingShaderLoads = 0;

        this.texturesToCreate = new Queue();
        this.pendingTextureLoads = 0;

        this.createSamplers = true;
        this.createRenderStates = true;
    }

    LoadResources.prototype.finishedPendingLoads = function() {
        return ((this.pendingBufferLoads === 0) &&
                (this.pendingShaderLoads === 0) &&
                (this.pendingTextureLoads === 0));
    };

    LoadResources.prototype.finishedResourceCreation = function() {
        return ((this.bufferViewsToCreate.length === 0) &&
                (this.programsToCreate.length === 0) &&
                (this.texturesToCreate.length === 0));
    };

    LoadResources.prototype.finishedBufferViewsCreation = function() {
        return ((this.pendingBufferLoads === 0) && (this.bufferViewsToCreate.length === 0));
    };

    LoadResources.prototype.finishedProgramCreation = function() {
        return ((this.pendingShaderLoads === 0) && (this.programsToCreate.length === 0));
    };

    LoadResources.prototype.finishedTextureCreation = function() {
        return ((this.pendingTextureLoads === 0) && (this.texturesToCreate.length === 0));
    };

// TODO: what data should we pass to all events?

    /**
     * DOC_TBA
     *
     * @alias Model
     * @constructor
     */
    var Model = function(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        /**
         * DOC_TBA
         */
        this.gltf = options.gltf;

        /**
         * DOC_TBA
         */
        this.basePath = defaultValue(options.basePath, '');

        /**
         * Determines if the model primitive will be shown.
         *
         * @type {Boolean}
         *
         * @default true
         */
        this.show = defaultValue(options.show, true);

        /**
         * The 4x4 transformation matrix that transforms the model from model to world coordinates.
         * When this is the identity matrix, the model is drawn in world coordinates, i.e., Earth's WGS84 coordinates.
         * Local reference frames can be used by providing a different transformation matrix, like that returned
         * by {@link Transforms.eastNorthUpToFixedFrame}.  This matrix is available to GLSL vertex and fragment
         * shaders via {@link czm_model} and derived uniforms.
         *
         * @type {Matrix4}
         *
         * @default {@link Matrix4.IDENTITY}
         *
         * @example
         * var origin = ellipsoid.cartographicToCartesian(
         *   Cartographic.fromDegrees(-95.0, 40.0, 200000.0));
         * m.modelMatrix = Transforms.eastNorthUpToFixedFrame(origin);
         *
         * @see Transforms.eastNorthUpToFixedFrame
         * @see czm_model
         */
        this.modelMatrix = Matrix4.clone(defaultValue(options.modelMatrix, Matrix4.IDENTITY));
        this._modelMatrix = Matrix4.clone(this.modelMatrix);

        /**
         * A uniform scale applied to this model before the {@link Model#modelMatrix}.
         * Values greater than <code>1.0</code> increase the size of the model; values
         * less than <code>1.0</code> decrease.
         *
         * @type {Number}
         *
         * @default 1.0
         */
        this.scale = defaultValue(options.scale, 1.0);
        this._scale = this.scale;

        /**
         * User-defined object returned when the model is picked.
         *
         * @type Object
         *
         * @default undefined
         *
         * @see Scene#pick
         */
        this.id = options.id;
        this._id = options.id;

        /**
         * DOC_TBA
         */
        this.jsonLoad = new Event();

        /**
         * DOC_TBA
         */
        this.readyToRender = new Event();

// TODO: will change with animation
// TODO: only load external files if within bounding sphere
// TODO: cull whole model, not commands?  Good for our use-cases, but not buildings, etc.
        /**
         * DOC_TBA
         */
        this.worldBoundingSphere = new BoundingSphere();

        /**
         * DOC_TBA
         *
         * @readonly
         */
        this.debugShowBoundingVolume = defaultValue(options.debugShowBoundingVolume, false);

        this._computedModelMatrix = new Matrix4(); // Derived from modelMatrix and scale
        this._state = ModelState.NEEDS_LOAD;
        this._loadResources = undefined;

        this._commandLists = new CommandLists();
        this._pickIds = [];
    };

    /**
     * DOC_TBA
     */
    Model.fromText = function(options) {
        if (!defined(options) || !defined(options.url)) {
            throw new DeveloperError('options.url is required');
        }

        var url = options.url;
        var basePath = '';
        var i = url.lastIndexOf('/');
        if (i !== -1) {
            basePath = url.substring(0, i + 1);
        }

        var model = new Model({
            show : options.show,
            modelMatrix : options.modelMatrix,
            scale : options.scale,
            id : options.id,
            debugShowBoundingVolume : options.debugShowBoundingVolume
        });

        loadText(url, options.headers).then(function(data) {
            model.gltf = JSON.parse(data);
            model.basePath = basePath;
            model.jsonLoad.raiseEvent();
        });

        return model;
    };

    ///////////////////////////////////////////////////////////////////////////

    function getFailedLoadFunction(type, path) {
        return function() {
            throw new RuntimeError('Failed to load external ' + type + ': ' + path);
        };
    }

    function bufferLoad(model, name) {
        return function(arrayBuffer) {
            var loadResources = model._loadResources;
            loadResources.buffers[name] = arrayBuffer;
            --loadResources.pendingBufferLoads;
         };
    }

    function parseBuffers(model) {
        var buffers = model.gltf.buffers;
        for (var name in buffers) {
            if (buffers.hasOwnProperty(name)) {
                ++model._loadResources.pendingBufferLoads;
                var bufferPath = model.basePath + buffers[name].path;
                loadArrayBuffer(bufferPath).then(bufferLoad(model, name), getFailedLoadFunction('buffer', bufferPath));
            }
        }
    }

    function parseBufferViews(model) {
        var bufferViews = model.gltf.bufferViews;
        for (var name in bufferViews) {
            if (bufferViews.hasOwnProperty(name)) {
                model._loadResources.bufferViewsToCreate.enqueue(name);
            }
        }
    }

    function shaderLoad(model, name) {
        return function(source) {
            var loadResources = model._loadResources;
            loadResources.shaders[name] = source;
            --loadResources.pendingShaderLoads;
         };
    }

    function parseShaders(model) {
        var shaders = model.gltf.shaders;
        for (var name in shaders) {
            if (shaders.hasOwnProperty(name)) {
                ++model._loadResources.pendingShaderLoads;
                var shaderPath = model.basePath + shaders[name].path;
                loadText(shaderPath).then(shaderLoad(model, name), getFailedLoadFunction('shader', shaderPath));
            }
        }
    }

    function parsePrograms(model) {
        var programs = model.gltf.programs;
        for (var name in programs) {
            if (programs.hasOwnProperty(name)) {
                model._loadResources.programsToCreate.enqueue(name);
            }
        }
    }

    function imageLoad(model, name) {
        return function(image) {
            var loadResources = model._loadResources;
            --loadResources.pendingTextureLoads;
            loadResources.texturesToCreate.enqueue({
                 name : name,
                 image : image
             });
         };
    }

    function parseTextures(model) {
        var images = model.gltf.images;
        var textures = model.gltf.textures;
        for (var name in textures) {
            if (textures.hasOwnProperty(name)) {
                ++model._loadResources.pendingTextureLoads;
                var imagePath = model.basePath + images[textures[name].source].path;
                loadImage(imagePath).then(imageLoad(model, name), getFailedLoadFunction('image', imagePath));
            }
        }
    }

    var defaultTranslation = Cartesian3.ZERO;
    var defaultRotation = Quaternion.IDENTITY;
    var defaultScale = new Cartesian3(1.0, 1.0, 1.0);
    var scratchAxis = new Cartesian3();

    function parseNodes(model) {
        var nodes = model.gltf.nodes;
        for (var name in nodes) {
            if (nodes.hasOwnProperty(name)) {
                var node = nodes[name];

                node.czm = {
                    meshesCommands : {},
                    transformToRoot : new Matrix4(),
                    translation : undefined,
                    rotation : undefined,
                    scale : undefined
                };

                // TRS converted to Cesium types
                if (defined(node.translation)) {
                    node.czm.translation = Cartesian3.fromArray(node.translation);
                } else {
                    node.czm.translation = Cartesian3.clone(defaultTranslation);
                }

                if (defined(node.rotation)) {
                    var axis = Cartesian3.fromArray(node.rotation, 0, scratchAxis);
                    var angle = node.rotation[3];
                    node.czm.rotation = Quaternion.fromAxisAngle(axis, angle);
                } else {
                    node.czm.rotation = Quaternion.clone(defaultRotation);
                }

                if (defined(node.scale)) {
                    node.czm.scale = Cartesian3.fromArray(node.scale);
                } else {
                    node.czm.scale = Cartesian3.clone(defaultScale);
                }
            }
        }
    }

    function parse(model) {
        parseBuffers(model);
        parseBufferViews(model);
        parseShaders(model);
        parsePrograms(model);
        parseTextures(model);
        parseNodes(model);
    }

    ///////////////////////////////////////////////////////////////////////////

    function createBuffers(model, context) {
        var loadResources = model._loadResources;

// TODO: more fine-grained bufferView-to-buffer dependencies
        if (loadResources.pendingBufferLoads !== 0) {
            return;
        }

        var raw;
        var bufferView;
        var bufferViews = model.gltf.bufferViews;
        var buffers = loadResources.buffers;

        while (loadResources.bufferViewsToCreate.length > 0) {
            var bufferViewName = loadResources.bufferViewsToCreate.dequeue();
            bufferView = bufferViews[bufferViewName];
            bufferView.czm = {
                webglBuffer : undefined
            };

            if (bufferView.target === 'ARRAY_BUFFER') {
                // Only ARRAY_BUFFER here.  ELEMENT_ARRAY_BUFFER created below.
                raw = new Uint8Array(buffers[bufferView.buffer], bufferView.byteOffset, bufferView.byteLength);
                var vertexBuffer = context.createVertexBuffer(raw, BufferUsage.STATIC_DRAW);
                vertexBuffer.setVertexArrayDestroyable(false);
                bufferView.czm.webglBuffer = vertexBuffer;
            }

            // bufferViews referencing animations are ignored here and handled in createAnimations.
        }

        // The Cesium Renderer requires knowing the datatype for an index buffer
        // at creation type, which is not part of the glTF bufferview so loop
        // through glTF indices to create the bufferview's index buffer.
        var indices = model.gltf.indices;
        for (var name in indices) {
            if (indices.hasOwnProperty(name)) {
                var instance = indices[name];
                bufferView = bufferViews[instance.bufferView];

                if (!defined(bufferView.czm.webglBuffer)) {
                    raw = new Uint8Array(buffers[bufferView.buffer], bufferView.byteOffset, bufferView.byteLength);
                    var indexBuffer = context.createIndexBuffer(raw, BufferUsage.STATIC_DRAW, IndexDatatype[instance.type]);
                    indexBuffer.setVertexArrayDestroyable(false);
                    bufferView.czm.webglBuffer = indexBuffer;
                    // In theory, several glTF indices with different types could
                    // point to the same glTF bufferView, which would break this.
                    // In practice, it is unlikely as it will be UNSIGNED_SHORT.
                }
            }
        }
    }

    function createPrograms(model, context) {
        var loadResources = model._loadResources;

// TODO: more fine-grained program-to-shader dependencies
        if (loadResources.pendingShaderLoads !== 0) {
            return;
        }

        var programs = model.gltf.programs;
        var shaders = loadResources.shaders;

        // Create one program per frame
        if (loadResources.programsToCreate.length > 0) {
            var name = loadResources.programsToCreate.dequeue();
            var program = programs[name];

            var vs = shaders[program.vertexShader];
            var fs = shaders[program.fragmentShader];
// TODO: glTF needs translucent flag so we know if we need its fragment shader.
            var pickFS = createShaderSource({
                sources : [fs],
                pickColorQualifier : 'uniform'
            });

            program.czm = {
                program : context.getShaderCache().getShaderProgram(vs, fs),
                pickProgram : context.getShaderCache().getShaderProgram(vs, pickFS)
            };
// TODO: in theory, pickProgram could have a different set of attribute locations
        }
    }

    function createSamplers(model, context) {
        var loadResources = model._loadResources;

        if (loadResources.createSamplers) {
            loadResources.createSamplers = false;

            var samplers = model.gltf.samplers;
            for (var name in samplers) {
                if (samplers.hasOwnProperty(name)) {
                    var sampler = samplers[name];

                    sampler.czm = {
                        sampler : context.createSampler({
                            wrapS : TextureWrap[sampler.wrapS],
                            wrapT : TextureWrap[sampler.wrapT],
                            minificationFilter : TextureMinificationFilter[sampler.minFilter],
                            magnificationFilter : TextureMagnificationFilter[sampler.magFilter]
                        })
                    };

// TODO: Workaround https://github.com/KhronosGroup/glTF/issues/120
                    var minFilter;

                    if ((sampler.minFilter === 'NEAREST_MIPMAP_NEAREST') ||
                        (sampler.minFilter === 'NEAREST_MIPMAP_LINEAR')) {
                        minFilter = 'NEAREST';
                    } else if ((sampler.minFilter === 'LINEAR_MIPMAP_NEAREST') ||
                               (sampler.minFilter === 'LINEAR_MIPMAP_LINEAR')) {
                        minFilter = 'LINEAR';
                    } else {
                        minFilter = sampler.minFilter;
                    }

                    // Can't mipmap, REPEAT, or MIRRORED_REPEAT NPOT texture.
                    sampler.czm.samplerWithoutMipmaps = context.createSampler({
                        wrapS : TextureWrap.CLAMP,
                        wrapT : TextureWrap.CLAMP,
                        minificationFilter : TextureMinificationFilter[minFilter],
                        magnificationFilter : TextureMagnificationFilter[sampler.magFilter]
                    });
// End workaround
                }
            }
        }
    }

    function createTextures(model, context) {
        var loadResources = model._loadResources;
        var textures = model.gltf.textures;

        // Create one texture per frame
        if (loadResources.texturesToCreate.length > 0) {
            var textureToCreate = loadResources.texturesToCreate.dequeue();

// TODO: consider target, format, and internalFormat
            var texture = textures[textureToCreate.name];
            texture.czm = {
                texture : context.createTexture2D({
                    source : textureToCreate.image,
                    flipY : false
                })
            };
// TODO: texture cache
        }
    }

    function getSemanticToAttributeLocations(model, primitive) {
// TODO: this could be done per material, not per mesh, if we don't change glTF
        var gltf = model.gltf;
        var programs = gltf.programs;
        var techniques = gltf.techniques;
        var materials = gltf.materials;

        // Retrieve the compiled shader program to assign index values to attributes
        var semanticToAttributeLocations = {};

        var technique = techniques[materials[primitive.material].instanceTechnique.technique];
        var parameters = technique.parameters;
        var pass = technique.passes[technique.pass];
        var instanceProgram = pass.instanceProgram;
        var program = programs[instanceProgram.program];
        var attributes = instanceProgram.attributes;
        var attributeLocations = program.czm.program.getVertexAttributes();

        for (var name in attributes) {
            if (attributes.hasOwnProperty(name)) {
                var parameter = parameters[attributes[name]];

                semanticToAttributeLocations[parameter.semantic] = attributeLocations[name].index;
            }
        }

        return semanticToAttributeLocations;
    }

    function createAnimations(model) {
        var loadResources = model._loadResources;

// TODO: more fine-grained buffer-view-to-webgl-or-animation-buffer dependencies
         if (!loadResources.finishedPendingLoads()) {
             return;
         }

         var animations = model.gltf.animations;
         var name;

         for (name in animations) {
             if (animations.hasOwnProperty(name)) {
                 var animation = animations[name];
                 var parameters = animation.parameters;

                 for (name in parameters) {
                     if (parameters.hasOwnProperty(name)) {
                         var parameter = parameters[name];
                         parameter.czm = {
                             values : ModelCache.getAnimationParameterValues(model, parameter)
                         };
                     }
                 }
             }
         }
    }

    function createVertexArrays(model, context) {
        var loadResources = model._loadResources;

// TODO: more fine-grained mesh-to-buffer-views dependencies
         if (!loadResources.finishedBufferViewsCreation() || !loadResources.finishedProgramCreation()) {
             return;
         }

         var gltf = model.gltf;
         var bufferViews = gltf.bufferViews;
         var attributes = gltf.attributes;
         var indices = gltf.indices;
         var meshes = gltf.meshes;
         var name;

         for (name in meshes) {
             if (meshes.hasOwnProperty(name)) {
                 var primitives = meshes[name].primitives;

                 for (name in primitives) {
                     if (primitives.hasOwnProperty(name)) {
                         var primitive = primitives[name];

                         var semanticToAttributeLocations = getSemanticToAttributeLocations(model, primitive);
                         var attrs = [];
                         var semantics = primitive.semantics;
                         for (name in semantics) {
                             if (semantics.hasOwnProperty(name)) {
                                 var a = attributes[semantics[name]];

                                 var type = ModelTypes[a.type];
                                 attrs.push({
                                     index                  : semanticToAttributeLocations[name],
                                     vertexBuffer           : bufferViews[a.bufferView].czm.webglBuffer,
                                     componentsPerAttribute : type.componentsPerAttribute,
                                     componentDatatype      : type.componentDatatype,
                                     normalize              : false,
                                     offsetInBytes          : a.byteOffset,
                                     strideInBytes          : a.byteStride
                                 });
                             }
                         }

                         var i = indices[primitive.indices];
                         var indexBuffer = bufferViews[i.bufferView].czm.webglBuffer;

                         primitive.czm = {
                             vertexArray : context.createVertexArray(attrs, indexBuffer)
                         };
                     }
                 }
             }
         }
    }

    function createRenderStates(model, context) {
        var loadResources = model._loadResources;

        if (loadResources.createRenderStates) {
            loadResources.createRenderStates = false;

            var techniques = model.gltf.techniques;
            for (var name in techniques) {
                if (techniques.hasOwnProperty(name)) {
                    var technique = techniques[name];
                    var pass = technique.passes[technique.pass];
                    var states = pass.states;

                    states.czm = {
                        renderState : context.createRenderState({
                            cull : {
                                enabled : states.cullFaceEnable
                            },
                            depthTest : {
                                enabled : states.depthTestEnable
                            },
                            depthMask : states.depthMask,
                            blending : states.blendEnable ? BlendingState.ALPHA_BLEND : BlendingState.DISABLED
                        })
                    };
                }
            }
        }
    }

    var gltfSemanticUniforms = {
// TODO: All semantics
        WORLD : function(uniformState) {
            return function() {
                return uniformState.getModel();
            };
        },
        VIEW : function(uniformState) {
            return function() {
                return uniformState.getView();
            };
        },
        PROJECTION : function(uniformState) {
            return function() {
                return uniformState.getProjection();
            };
        },
        WORLDVIEW : function(uniformState) {
            return function() {
                return uniformState.getModelView();
            };
        },
        VIEWPROJECTION : function(uniformState) {
            return function() {
                return uniformState.getViewProjection();
            };
        },
        WORLDVIEWPROJECTION : function(uniformState) {
            return function() {
                return uniformState.getModelViewProjection();
            };
        },
        WORLDINVERSE : function(uniformState) {
            return function() {
                return uniformState.getInverseModel();
            };
        },
        VIEWINVERSE : function(uniformState) {
            return function() {
                return uniformState.getInverseView();
            };
        },
        PROJECTIONINVERSE : function(uniformState) {
            return function() {
                return uniformState.getInverseProjection();
            };
        },
        WORLDVIEWINVERSE : function(uniformState) {
            return function() {
                return uniformState.getInverseModelView();
            };
        },
        VIEWPROJECTIONINVERSE : function(uniformState) {
            return function() {
                return uniformState.getInverseViewProjection();
            };
        },
        WORLDVIEWINVERSETRANSPOSE : function(uniformState) {
            return function() {
                return uniformState.getNormal();
            };
        }
    };

    var gltfUniformFunctions = {
// TODO: All types
         FLOAT : function(value, model, context) {
             return function() {
                 return value;
             };
         },
         FLOAT_VEC2 : function(value, model, context) {
             var v = Cartesian2.fromArray(value);

             return function() {
                 return v;
             };
         },
         FLOAT_VEC3 : function(value, model, context) {
             var v = Cartesian3.fromArray(value);

             return function() {
                 return v;
             };
         },
         FLOAT_VEC4 : function(value, model, context) {
             var v = Cartesian4.fromArray(value);

             return function() {
                 return v;
             };
         },
         SAMPLER_2D : function(value, model, context) {
             var texture = model.gltf.textures[value];
             var tx = texture.czm.texture;
             var sampler = model.gltf.samplers[texture.sampler];

// TODO: Workaround https://github.com/KhronosGroup/glTF/issues/120
             var dimensions = tx.getDimensions();
             if (!CesiumMath.isPowerOfTwo(dimensions.x) || !CesiumMath.isPowerOfTwo(dimensions.y)) {
                 tx.setSampler(sampler.czm.samplerWithoutMipmaps);
             } else {
// End workaround
                 if ((sampler.minFilter === 'NEAREST_MIPMAP_NEAREST') ||
                     (sampler.minFilter === 'LINEAR_MIPMAP_NEAREST') ||
                     (sampler.minFilter === 'NEAREST_MIPMAP_LINEAR') ||
                     (sampler.minFilter === 'LINEAR_MIPMAP_LINEAR')) {
                     tx.generateMipmap();
                 }
                 tx.setSampler(sampler.czm.sampler);
             }

             return function() {
                 return tx;
             };
         }
    };

    function createUniformMaps(model, context) {
        var loadResources = model._loadResources;

// TODO: more fine-grained texture dependencies
        if (!loadResources.finishedTextureCreation()) {
            return;
        }

        var name;
        var materials = model.gltf.materials;
        var techniques = model.gltf.techniques;

        for (name in materials) {
            if (materials.hasOwnProperty(name)) {
                var material = materials[name];
                var instanceTechnique = material.instanceTechnique;
                var technique = techniques[instanceTechnique.technique];
                var parameters = technique.parameters;
                var pass = technique.passes[technique.pass];
                var instanceProgram = pass.instanceProgram;
                var uniforms = instanceProgram.uniforms;

                var parameterValues = {};

                // Uniform parameters for this pass
                for (name in uniforms) {
                    if (uniforms.hasOwnProperty(name)) {
                        var parameterName = uniforms[name];
                        var parameter = parameters[parameterName];
                        parameterValues[parameterName] = {
                            uniformName : name,
// TODO: account for parameter.type with semantic
                            func : defined(parameter.semantic) ? gltfSemanticUniforms[parameter.semantic](context.getUniformState()) : undefined
                        };
                    }
                }

                // Parameter overrides by the instance technique
// TODO: this overrides semantics?  What should the glTF spec say?
                var instanceParameters = instanceTechnique.values;
                var length = instanceParameters.length;
                for (var i = 0; i < length; ++i) {
                    var instanceParam = instanceParameters[i];
                    var parameterValue = parameterValues[instanceParam.parameter];

                    parameterValue.func = gltfUniformFunctions[parameters[instanceParam.parameter].type](instanceParam.value, model, context);
                }

                // Create uniform map
                var uniformMap = {};
                for (name in parameterValues) {
                    if (parameterValues.hasOwnProperty(name)) {
                        var pv = parameterValues[name];
                        uniformMap[pv.uniformName] = pv.func;
                    }
                }

                instanceTechnique.czm = {
                    uniformMap : uniformMap
                };
            }
        }
    }

    function createPickColorFunction(color) {
        return function() {
            return color;
        };
    }

    function createCommand(model, node, context) {
        var czmMeshesCommands = node.czm.meshesCommands;

        var colorCommands = model._commandLists.colorList;
        var pickCommands = model._commandLists.pickList;
        var pickIds = model._pickIds;
        var debugShowBoundingVolume = model.debugShowBoundingVolume;

        var gltf = model.gltf;

        var attributes = gltf.attributes;
        var indices = gltf.indices;
        var gltfMeshes = gltf.meshes;

        var programs = gltf.programs;
        var techniques = gltf.techniques;
        var materials = gltf.materials;

        var meshes = node.meshes;
        var meshesLength = meshes.length;

        for (var j = 0; j < meshesLength; ++j) {
            var name = meshes[j];
            var mesh = gltfMeshes[name];
            var primitives = mesh.primitives;
            var length = primitives.length;

            // The glTF node hierarchy is a DAG so a node can have more than one
            // parent, so a node may already have commands.  If so, append more
            // since they will have a different model matrix.
            czmMeshesCommands[name] = defaultValue(czmMeshesCommands[name], []);
            var meshesCommands = czmMeshesCommands[name];

            for (var i = 0; i < length; ++i) {
                var primitive = primitives[i];
                var ix = indices[primitive.indices];
                var instanceTechnique = materials[primitive.material].instanceTechnique;
                var technique = techniques[instanceTechnique.technique];
                var pass = technique.passes[technique.pass];
                var instanceProgram = pass.instanceProgram;

                var boundingSphere;
                var positionAttribute = primitive.semantics.POSITION;
                if (defined(positionAttribute)) {
                    var a = attributes[positionAttribute];
                    boundingSphere = BoundingSphere.fromCornerPoints(Cartesian3.fromArray(a.min), Cartesian3.fromArray(a.max));
                }

                var primitiveType = PrimitiveType[primitive.primitive];
                var vertexArray = primitive.czm.vertexArray;
                var count = ix.count;
                var offset = (ix.byteOffset / IndexDatatype[ix.type].sizeInBytes);  // glTF has offset in bytes.  Cesium has offsets in indices
                var uniformMap = instanceTechnique.czm.uniformMap;
                var rs = pass.states.czm.renderState;
                var owner = {
                    primitive : model,
                    id : model.id,
                    gltf : {
                        node : node,
                        mesh : mesh,
                        primitive : primitive
                    }
                };

                var command = new DrawCommand();
                command.boundingVolume = BoundingSphere.clone(boundingSphere); // updated in update()
                command.modelMatrix = new Matrix4();                           // computed in update()
                command.primitiveType = primitiveType;
                command.vertexArray = vertexArray;
                command.count = count;
                command.offset = offset;
                command.shaderProgram = programs[instanceProgram.program].czm.program;
                command.uniformMap = uniformMap;
                command.renderState = rs;
                command.owner = owner;
                command.debugShowBoundingVolume = debugShowBoundingVolume;
                colorCommands.push(command);

                var pickId = context.createPickId(owner);
                pickIds.push(pickId);

                var pickUniformMap = combine([
                    uniformMap, {
                        czm_pickColor : createPickColorFunction(pickId.color)
                    }], false, false);

                var pickCommand = new DrawCommand();
                pickCommand.boundingVolume = BoundingSphere.clone(boundingSphere); // updated in update()
                pickCommand.modelMatrix = new Matrix4();                           // computed in update()
                pickCommand.primitiveType = primitiveType;
                pickCommand.vertexArray = vertexArray;
                pickCommand.count = count;
                pickCommand.offset = offset;
                pickCommand.shaderProgram = programs[instanceProgram.program].czm.pickProgram;
                pickCommand.uniformMap = pickUniformMap;
                pickCommand.renderState = rs;
                pickCommand.owner = owner;
                pickCommands.push(pickCommand);

                meshesCommands.push({
                    command : command,
                    pickCommand : pickCommand
                });
            }
        }
    }

    function createCommands(model, context) {
        var loadResources = model._loadResources;

// TODO: more fine-grained dependencies
        if (!loadResources.finishedPendingLoads() || !loadResources.finishedResourceCreation()) {
            return;
        }

        // Create commands for nodes in the default scene.

        var gltf = model.gltf;
        var nodes = gltf.nodes;

        var scene = gltf.scenes[gltf.scene];
        var sceneNodes = scene.nodes;
        var length = sceneNodes.length;

        var stack = [];

        for (var i = 0; i < length; ++i) {
            stack.push(nodes[sceneNodes[i]]);

            while (stack.length > 0) {
                var node = stack.pop();

                // TODO: handle camera and light nodes
                if (defined(node.meshes)) {
                    createCommand(model, node, context);
                }

                var children = node.children;
                var childrenLength = children.length;
                for (var k = 0; k < childrenLength; ++k) {
                    stack.push(nodes[children[k]]);
                }
            }
        }
    }

    function createResources(model, context) {
        createBuffers(model, context);      // using glTF bufferViews
        createPrograms(model, context);
        createSamplers(model, context);
        createTextures(model, context);

        createAnimations(model);
        createVertexArrays(model, context); // using glTF meshes
        createRenderStates(model, context); // using glTF materials/techniques/passes/states
        createUniformMaps(model, context);  // using glTF materials/techniques/passes/instanceProgram

        createCommands(model, context);     // using glTF scene
    }

    ///////////////////////////////////////////////////////////////////////////

    function getNodeMatrix(node, result) {
        if (defined(node.matrix)) {
            return Matrix4.fromColumnMajorArray(node.matrix, result);
        }

        var czm = node.czm;
        return Matrix4.fromTranslationQuaternionRotationScale(czm.translation, czm.rotation, czm.scale, result);
    }

    // To reduce allocations in update()
    var scratchNodeStack = [];
    var scratchSpheres = [];

    function updateModelMatrix(model) {
        var gltf = model.gltf;
        var scenes = gltf.scenes;
        var nodes = gltf.nodes;

        var scene = scenes[gltf.scene];
        var sceneNodes = scene.nodes;
        var length = sceneNodes.length;

        var nodeStack = scratchNodeStack;

        // Compute bounding sphere that includes all transformed nodes
        var spheres = scratchSpheres;
        var sphereCenter = new Cartesian3();

        for (var i = 0; i < length; ++i) {
            var n = nodes[sceneNodes[i]];

            getNodeMatrix(n, n.czm.transformToRoot);
            nodeStack.push(n);

            while (nodeStack.length > 0) {
                n = nodeStack.pop();
                var transformToRoot = n.czm.transformToRoot;

//TODO: handle camera and light nodes
                var meshCommands = n.czm.meshesCommands;
                var name;
                for (name in meshCommands) {
                    if (meshCommands.hasOwnProperty(name)) {
                        var meshCommand = meshCommands[name];
                        var meshCommandLength = meshCommand.length;
                        for (var j = 0 ; j < meshCommandLength; ++j) {
                            var primitiveCommand = meshCommand[j];
                            var command = primitiveCommand.command;
                            var pickCommand = primitiveCommand.pickCommand;

                            Matrix4.multiply(model._computedModelMatrix, transformToRoot, command.modelMatrix);
                            Matrix4.clone(command.modelMatrix, pickCommand.modelMatrix);

                            var bs = new BoundingSphere();
                            BoundingSphere.transform(command.boundingVolume, command.modelMatrix, bs);
                            Cartesian3.add(bs.center, sphereCenter, sphereCenter);
                            spheres.push(bs);
                        }
                    }
                }

                var children = n.children;
                var childrenLength = children.length;
                for (var k = 0; k < childrenLength; ++k) {
                    var child = nodes[children[k]];

                    var childMatrix = getNodeMatrix(child, child.czm.transformToRoot);
                    Matrix4.multiply(transformToRoot, childMatrix, child.czm.transformToRoot);
                    nodeStack.push(child);
                }
            }
        }

        // Compute bounding sphere around the model
        var radius = 0;

        length = spheres.length;
        Cartesian3.divideByScalar(sphereCenter, length, sphereCenter);
        for (i = 0; i < length; ++i) {
            var bbs = spheres[i];
            var r = Cartesian3.magnitude(Cartesian3.subtract(bbs.center, sphereCenter)) + bbs.radius;

            if (r > radius) {
                radius = r;
            }
        }

        Cartesian3.clone(sphereCenter, model.worldBoundingSphere.center);
        model.worldBoundingSphere.radius = radius;
    }

    var frameCount = 0;
    var ccc_count = 0;

    function raiseAnimationEvents(scheduledAnimation) {
        if (defined(scheduledAnimation.start)) {
            if (ccc_count === 0) {
                scheduledAnimation.start.raiseEvent();
            }
        }

        if (defined(scheduledAnimation.stop)) {
            if (ccc_count === scheduledAnimation.animation.count - 1) {
                scheduledAnimation.stop.raiseEvent();
            }
        }
    }

    var axisAnimateScratch = new Cartesian3();

    function animate(model) {
        var scheduledAnimation = model._animation;
        if (defined(scheduledAnimation)) {
            var animation = scheduledAnimation.animation;

            raiseAnimationEvents(scheduledAnimation);

            var nodes = model.gltf.nodes;
            var parameters = animation.parameters;
            var samplers = animation.samplers;
            var channels = animation.channels;
            var length = channels.length;

            for (var i = 0; i < length; ++i) {
                var channel = channels[i];

                var target = channel.target;
                // TODO: Support other targets when glTF does: https://github.com/KhronosGroup/glTF/issues/142
                var czmNode = nodes[target.id].czm;
                var animatingProperty = czmNode[target.path];

                var sampler = samplers[channel.sampler];
                var parameter = parameters[sampler.output];
                // TODO: Ignoring sampler.interpolation for now: https://github.com/KhronosGroup/glTF/issues/156

                // TODO: interpolate key frames
                parameter.czm.values[ccc_count].clone(animatingProperty);
            }

            if (frameCount++ % 4 === 0) {
                if (ccc_count++ === animation.count - 1) {
                    ccc_count = 0;
                }
            }

            return true;
        }

        return false;
    }

    function updatePickIds(model, context) {
        var id = model.id;
        if (model._id !== id) {
            model._id = id;

            var pickIds = model._pickIds;
            var length = pickIds.length;
            for (var i = 0; i < length; ++i) {
                context.getObjectByPickColor(pickIds[i].color).id = id;
            }
        }
    }

    /**
     * @exception {RuntimeError} Failed to load external reference.
     *
     * @private
     */
    Model.prototype.update = function(context, frameState, commandList) {
        if (!this.show ||
            (frameState.mode !== SceneMode.SCENE3D)) {
// TODO: models in 2D and Columbus view
            return;
        }

        if ((this._state === ModelState.NEEDS_LOAD) && defined(this.gltf)) {
            this._state = ModelState.LOADING;
            this._loadResources = new LoadResources();
            parse(this);
        }

        var justLoaded = false;
        var commandLists = this._commandLists;

        if (this._state === ModelState.LOADING) {
            // Incrementally create WebGL resources as buffers/shaders/textures are downloaded
            createResources(this, context);

            var loadResources = this._loadResources;
            if (loadResources.finishedPendingLoads() && loadResources.finishedResourceCreation()) {
                this._state = ModelState.LOADED;
                this._loadResources = undefined;  // Clear CPU memory since WebGL resources were created.
                justLoaded = true;
            }
        }

        // Update modelMatrix throughout the tree as needed
        if (this._state === ModelState.LOADED) {
// TODO: fine-grained partial hiearchy updates for animation
            var animated = animate(this);

            if (animated || !Matrix4.equals(this._modelMatrix, this.modelMatrix) || (this._scale !== this.scale) || justLoaded) {
                Matrix4.clone(this.modelMatrix, this._modelMatrix);
                this._scale = this.scale;
                Matrix4.multiplyByUniformScale(this.modelMatrix, this.scale, this._computedModelMatrix);

                updateModelMatrix(this);
            }
        }

        if (justLoaded) {
            // Call after modelMatrix update.
            frameState.events.push(this.readyToRender);
        }

        updatePickIds(this, context);

        commandList.push(commandLists);
    };

    /**
     * DOC_TBA
     *
     * @param {String} options.name DOC_TBA
     * @param {Event} [options.start] DOC_TBA
     * @param {Event} [options.stop] DOC_TBA
     *
     * @exception {DeveloperError} The gltf property is not defined.  Wait for the {@see Model#jsonLoad} event.
     * @exception {DeveloperError} options.name is required and must be a valid animation name.
     */
    Model.prototype.scheduleAnimation = function(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);
// TODO: options should take start time, etc.

        if (!defined(this.gltf)) {
            throw new DeveloperError('The gltf property is not defined.  Wait for the jsonLoad event.');
        }

        var animation = this.gltf.animations[options.name];

        if (!defined(animation)) {
            throw new DeveloperError('options.name is required and must be a valid animation name.');
        }


// TODO: data structure for all animations.  Should be able to remove them, etc.
        this._animation = {
            animation : animation,
            start : options.start,
            stop : options.stop
        };
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof Model
     *
     * @return {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
     *
     * @see Model#destroy
     */
    Model.prototype.isDestroyed = function() {
        return false;
    };

    function destroyCzm(property, resourceName) {
        for (var name in property) {
            if (property.hasOwnProperty(name)) {
                var czm = property[name].czm;
                if (defined(czm) && defined(czm[resourceName])) {
                    czm[resourceName] = czm[resourceName].destroy();
                }
            }
        }
    }

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @memberof Model
     *
     * @return {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see Model#isDestroyed
     *
     * @example
     * model = model && model.destroy();
     */
    Model.prototype.destroy = function() {
        var gltf = this.gltf;
        destroyCzm(gltf.bufferViews, 'webglBuffer');
        destroyCzm(gltf.programs, 'program');
        destroyCzm(gltf.programs, 'pickProgram');
        destroyCzm(gltf.textures, 'texture');

        var meshes = gltf.meshes;
        var name;

        for (name in meshes) {
            if (meshes.hasOwnProperty(name)) {
                var primitives = meshes[name].primitives;

                for (name in primitives) {
                    if (primitives.hasOwnProperty(name)) {
                        var czm = primitives[name].czm;
                        if (defined(czm) && defined(czm.vertexArray)) {
                            czm.vertexArray = czm.vertexArray.destroy();
                        }
                    }
                }
            }
        }

        var pickIds = this._pickIds;
        var length = pickIds.length;
        for (var i = 0; i < length; ++i) {
            pickIds[i].destroy();
        }

        return destroyObject(this);
    };

    return Model;
});
