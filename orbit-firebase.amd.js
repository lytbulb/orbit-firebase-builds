define('orbit-firebase/cache-source', ['exports', 'orbit/transformable', 'orbit/lib/objects'], function (exports, Transformable, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache){
			Transformable['default'].extend(this);
			this._cache = cache;
			objects.expose(this, this._cache, ['retrieve']);
		},

		_transform: function(operations){
			var _this = this;
			operations = objects.isArray(operations) ? operations : [operations];

			operations.forEach(function(operation){
				_this._cache.transform(operation);
			});
		}
	});

});
define('orbit-firebase/eager-relationship-loader', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(transformable, listener, schema){
			var _this = this;
			this._schema = schema;
			this._listener = listener;

			transformable.on("didTransform", function(operation){
				_this._process(operation);
			});
		},

		_process: function(operation){
			console.log("checking", operation);
			if(['add', 'replace'].indexOf(operation.op) === -1) return;
			if(operation.path[2] === '__rel') this._processLink(operation);
			if(operation.path.length === 2) this._processRecord(operation);

		},

		_processRecord: function(operation){
			var _this = this;
			var record = operation.value;
			var modelType = operation.path[0];
			var modelSchema = this._schema.models[modelType];

			Object.keys(modelSchema.links).forEach(function(link){
				var linkDef = _this._schema.models[modelType].links[link];
				var linkType = _this._schema.singularize(link);

				if(linkDef.type === 'hasOne'){
					if(record.__rel[link]){
						var id = record.__rel[link];
						_this._listener.subscribeToRecord(linkDef.model, id);
					}

				} else if (linkDef.type === 'hasMany'){
					if(record.__rel[link]){
						var ids = Object.keys(record.__rel[link]);
						_this._listener.subscribeToRecords(linkDef.model, ids);
					}
				}

			});
		},

		_processLink: function(operation){
			var modelType = operation.path[0];
			var link = operation.path[3];
			var linkDef = this._schema.models[modelType].links[link];
			var linkType = linkDef.model;
			var relationshipType = linkDef.type;
			var id, ids;

			if(relationshipType === 'hasMany'){
				if(operation.path.length === 4){
					ids = Object.keys(operation.value);
					this._listener.subscribeToRecords(linkType, ids);

				} else if (operation.path.length === 5){
					id = operation.path[4];
					this._listener.subscribeToRecord(linkType, id);

				}

			} else if (relationshipType === 'hasOne'){
				id = operation.value;
				this._listener.subscribeToRecord(linkType, id);

			}
			else {
				throw new Error("Relationship type not supported: " + relationshipType);
			}
		}
	});

});
define('orbit-firebase/firebase-client', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit-firebase/lib/array-utils'], function (exports, objects, Orbit, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef){
			this.firebaseRef = firebaseRef;
		},

		set: function(path, value){
			path = this._normalizePath(path);

			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				value = value || null; // undefined causes error in firebase client
				_this.firebaseRef.child(path).set(value, function(error){
					error ? reject(error) : resolve(value); // jshint ignore:line
				});
			});

		},

		push: function(path, value){
			var _this = this;
			return new Promise(function(resolve, reject){
				_this.firebaseRef.child(path).push(value, function(error){
					if(error) {
						reject(error);
					}
					else {
						resolve();
					}
				});
			});
		},

		remove: function(path){
			var _this = this;
			path = this._normalizePath(path);

			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).remove(function(error){
					error ? reject(error) : resolve(); // jshint ignore:line
				});
			});
		},

		valueAt: function(path){
			var _this = this;
			path = this._normalizePath(path);

			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).once('value', function(snapshot){

					resolve(snapshot.val());

				}, function(error){
					reject(reject);
				});
			});
		},
		
		removeFromArray: function(arrayPath, value){
			var _this = this;

			return this.valueAt(arrayPath).then(function(array){
				if(!array) return;
				console.log(array);

				var index = array.indexOf(value);
				if(index === -1) return Orbit['default'].resolve();

				array.splice(index, 1);
				return _this.set(arrayPath, array);
			});
		},

		removeFromArrayAt: function(arrayPath, index){
			var _this = this;
			arrayPath = this._normalizePath(arrayPath);

			return this.valueAt(arrayPath).then(function(array){
				if(!array) return;

				array = array_utils.removeAt(array, index);
				return _this.set(arrayPath, array);
			});
		},		

		appendToArray: function(arrayPath, value){
			var _this = this;
			arrayPath = this._normalizePath(arrayPath);

			return _this.valueAt(arrayPath).then(function(array){
				array = array || [];
				if(array.indexOf(value) === -1){
					array.push(value);
				}
				return _this.set(arrayPath, array);	

			});
		},

	    _normalizePath: function(path) {
	    	return (typeof path === 'string') ? path : path.join('/');
	    },	
	});

});
define('orbit-firebase/firebase-connector', ['exports', 'orbit/transform-connector'], function (exports, TransformConnector) {

	'use strict';

	exports['default'] = TransformConnector['default'].extend({
		filterFunction: function(operation){
			var path = operation.path;
			var recordPath = [path[0], path[1]];
			var record = this.target.retrieve(recordPath);

			if(!record && path.length > 2) return false;
			if(record && path.length === 2) return false;
			return true;
		}
	});

});
define('orbit-firebase/firebase-listener', ['exports', 'orbit/lib/objects', 'orbit/lib/eq', 'orbit/evented', 'orbit-firebase/lib/schema-utils', 'orbit/operation', 'orbit-firebase/firebase-client', 'orbit/main', 'orbit-firebase/lib/array-utils', 'orbit-firebase/subscriptions/record-subscription', 'orbit-firebase/subscriptions/attribute-subscription', 'orbit-firebase/subscriptions/has-many-subscription', 'orbit-firebase/subscriptions/has-one-subscription', 'orbit-firebase/subscriptions/options'], function (exports, objects, eq, Evented, SchemaUtils, Operation, FirebaseClient, Orbit, array_utils, RecordSubscription, AttributeSubscription, HasManySubscription, HasOneSubscription, subscriptions__options) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef, schema, serializer){
			Evented['default'].extend(this);

			this._firebaseRef = firebaseRef;
			this._firebaseClient = new FirebaseClient['default'](this._firebaseRef);
			this._schema = schema;
			this._schemaUtils = new SchemaUtils['default'](schema);
			this._serializer = serializer;

			this._listeners = {};
			this._subscriptions = {};
		},

		subscribeToType: function(type, _, subscriptionOptions){
			// console.log("subscribing to type", type);
			var _this = this;
			var typeRef = this._firebaseRef.child('type');
			subscriptionOptions = subscriptions__options.buildOptions(subscriptionOptions);

			this._enableListener(type, 'child_added', function(snapshot){
				var record = snapshot.val();
				// console.log("record added", record);
				_this.subscribeToRecord(type, record.id, subscriptionOptions);
			});
		},

		subscribeToRecords: function(type, ids, options){
			var _this = this;
			var promises = array_utils.map(ids, function(id){
				return _this.subscribeToRecord(type, id, options);
			});

			return Orbit['default'].all(promises);
		},

		subscribeToRecord: function(type, id, subscriptionOptions){
			var path = [type, id].join("/");
			subscriptionOptions = subscriptions__options.buildOptions(subscriptionOptions);

			return this._addSubscription(path, RecordSubscription['default'], subscriptionOptions);
		},

		subscriptions: function(){
			return Object.keys(this._listeners);
		},

		unsubscribeAll: function(){
			var _this = this;
			Object.keys(this._listeners).forEach(function(listenerKey){
				var path = listenerKey.split(":")[0];
				var eventType = listenerKey.split(":")[1];
				var callback = _this._listeners[listenerKey];

				_this._disableListener(path, eventType, callback);
			});
		},

		_subscribeToAttribute: function(type, id, attribute){
			var path = [type, id, attribute].join("/");
			return this._addSubscription(path, AttributeSubscription['default']);
		},

		_subscribeToLink: function(type, id, link, options){
			// console.log("subscribing to link", [type, id, link].join("/"));
			var _this = this;
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;

			if(linkType === 'hasOne'){
				return this._subscribeToHasOne(type, id, link, options);

			} else if (linkType === 'hasMany'){
				return this._subscribeToHasMany(type, id, link, options);

			} else {
				throw new Error("Unsupported link type: " + linkType);
			}

		},

		_subscribeToHasOne: function(type, id, link, options){
			// console.log("subscribing to hasOne", arguments);
			var _this = this;
			var path = [type, id, link].join("/");

			return this._addSubscription(path, HasOneSubscription['default'], options);
		},

		_findSubscription: function(path){
			return this._subscriptions[path];
		},

		_subscribeToHasMany: function(type, id, link, options){
			var _this = this;
			var path = [type, id, link].join("/");

			return this._addSubscription(path, HasManySubscription['default'], options);
		},

		_addSubscription: function(path, SubscriptionClass, subscriptionOptions){
			// console.log("subscription:add", path);
			var subscription = this._findSubscription(path);

			if(subscription){
				var mergedOptions = this._mergeOptions(subscription.options, subscriptionOptions);
				if(!eq.eq(mergedOptions, subscription.options)){
					// console.log("subscription:updating", path);
					subscription.options = subscriptionOptions;
					return subscription.update().then(function(){
						// console.log("subscription:updated", path);
					});
				}
				else {
					// console.log("subscription:duplicate", path);
					return Orbit['default'].resolve();
				}
			}
			else {
				// console.log("subscription:activating", path);
				subscription = new SubscriptionClass(path, this);
				subscription.options = subscriptionOptions || subscriptions__options.buildOptions({});
				this._subscriptions[path] = subscription;
				return subscription.activate().then(function(){
					// console.log("subscription:activated", path);
				});
			}
		},

		_mergeOptions: function(current, requested){
			return requested;
		},

		_emitDidTransform: function(operation){
			// console.log("emitting", operation.serialize());
			this.emit("didTransform", operation);
		},

		_enableListener: function(path, eventType, callback){
			var _this = this;
			path = (typeof path === 'string') ? path : path.join('/');
			var key = this._buildListenerKey(path, eventType);
			// console.log("enabling listener", key);

			if(this._listenerExists(key)) return Orbit['default'].resolve();

			return new Orbit['default'].Promise(function(resolve, reject){
				var wrappedCallback = function(){
					var result = callback.apply(_this, arguments);
					resolve(result);
				};

				_this._listeners[key] = wrappedCallback;
				_this._firebaseRef.child(path).on(eventType, wrappedCallback);
			});
		},

		_disableListener: function(path, eventType, callback){
			this._firebaseRef.child(path).off(eventType, callback);
		},

		_listenerExists: function(key){
			return this._listeners[key];
		},

		_buildListenerKey: function(path, eventType){
			return [path, eventType].join(":");
		},

		_normalizePath: function(path) {
			return (typeof path === 'string') ? path.split("/") : path;
		}
	});

});
define('orbit-firebase/firebase-requester', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/object-utils', 'orbit-firebase/lib/array-utils', 'orbit-firebase/lib/schema-utils', 'orbit/main', 'orbit/lib/assert', 'orbit-common/lib/exceptions'], function (exports, objects, object_utils, array_utils, SchemaUtils, Orbit, assert, exceptions) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer){
			assert.assert('FirebaseSource requires Orbit.map be defined', Orbit['default'].map);

			this._firebaseClient = firebaseClient;
			this._schema = schema;
			this._schemaUtils = new SchemaUtils['default'](schema);
			this._serializer = serializer;
		},

		find: function(type, id){
			if(id){
				if(objects.isArray(id)) return this._findMany(type, id);
				return this._findOne(type, id);
			}
			else {
				return this._findAll(type);
			}
		},

		findLink: function(type, id, link){
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;
			return this._firebaseClient.valueAt([type, id, link]).then(function(linkValue){
				if(linkType === 'hasMany') {
					return linkValue ? Object.keys(linkValue) : [];
				}
				else if(linkType === 'hasOne') {
					return linkValue;
				}
				throw new Error("Links of type " + linkType + " not handled");
			});
		},

		findLinked: function(type, id, link){
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;
			if(linkType === 'hasMany') {
				return this._findLinkedHasMany(type, id, link);
			}
			else if(linkType === 'hasOne') {
				return this._findLinkedHasOne(type, id, link);
			}
			throw new Error("Links of type " + linkType + " not handled");
		},

		_findOne: function(type, id){
			var _this = this;

			return _this._firebaseClient.valueAt([type, id]).then(function(record){
				// todo - is this the correct behaviour for not found?
				if(!record) throw new exceptions.RecordNotFoundException(type + ":" + id);
				return _this._serializer.deserialize(type, id, record);
			});
		},

		_findMany: function(type, ids){
			var _this = this;
			var promises = array_utils.map(ids, function(id){
				return _this._findOne(type, id);
			});

			return Orbit['default'].all(promises);
		},

		_findAll: function(type){
			var _this = this;
			return _this._firebaseClient.valueAt(type).then(function(recordsHash){
				var records = object_utils.objectValues(recordsHash);
				console.log("findAll results for: " + type, records);
				return _this._serializer.deserializeRecords(type, records);
			});
		},

		_findLinkedHasMany: function(type, id, link){
			console.log("fb._findLinkedHasMany", arguments);
			var _this = this;
			var linkDef = this._schemaUtils.lookupLinkDef(type, link);
			var model = linkDef.model;

			return this.findLink(type, id, link).then(function(ids){
				console.log("fb.findLink => ", ids);
				var promised = [];
				for(var i = 0; i < ids.length; i++){
					promised[i] = _this._firebaseClient.valueAt([model, ids[i]]);
				}

				return Orbit['default'].map(promised, function(record){
					return _this._serializer.deserialize(model, record.id, record);
				});
			});
		},

		_findLinkedHasOne: function(type, id, link){
			var _this = this;
			var linkDef = this._schemaUtils.lookupLinkDef(type, link);
			var model = linkDef.model;

			return this.findLink(type, id, link).then(function(id){
				return _this._firebaseClient.valueAt([model, id]).then(function(serializedRecord){
					return _this._serializer.deserialize(model, id, serializedRecord);
				});
			});
		}
	});

});
define('orbit-firebase/firebase-serializer', ['exports', 'orbit-common/serializer', 'orbit/lib/objects', 'orbit/lib/assert', 'orbit-firebase/transformations'], function (exports, Serializer, objects, assert, transformations) {

	'use strict';

	exports['default'] = Serializer['default'].extend({
		serialize: function(type, record){
			return this.serializeRecord(type, record);
		},

		serializeRecord: function(type, record) {
			assert.assert(record, "Must provide a record");

			var json = {};

			this.serializeKeys(type, record, json);
			this.serializeAttributes(type, record, json);
			this.serializeLinks(type, record, json);

			return json;
		},

		serializeKeys: function(type, record, json) {
			var modelSchema = this.schema.models[type];
			var resourceKey = this.resourceKey(type);
			var value = record[resourceKey];

			if (value) {
				json[resourceKey] = value;
			}
		},

		serializeAttributes: function(type, record, json) {
			var modelSchema = this.schema.models[type];

			Object.keys(modelSchema.attributes).forEach(function(attr) {
				this.serializeAttribute(type, record, attr, json);
			}, this);
		},

		serializeAttribute: function(type, record, attr, json) {
			var attrType = this.schema.models[type].attributes[attr].type;
			var transformation = transformations.lookupTransformation(attrType);
			var value = record[attr];
			var serialized = transformation.serialize(value);

			json[this.resourceAttr(type, attr)] = serialized;
		},

		serializeLinks: function(type, record, json) {
			var modelSchema = this.schema.models[type];
			var linkNames = Object.keys(modelSchema.links);

			linkNames.forEach(function(link){
				var value = record.__rel[link];
				json[link] = value;
			});
		},

		deserializeRecords: function(type, records){
			var _this = this;
			return records.map(function(record){
				return _this.deserialize(type, record.id, record);
			});
		},

		deserialize: function(type, id, record){
			record = record || {};
			var data = {};

			this.deserializeKeys(type, id, record, data);
			this.deserializeAttributes(type, record, data);
			this.deserializeLinks(type, record, data);

			return this.schema.normalize(type, data);
		},

		deserializeKeys: function(type, id, record, data){
			data[this.schema.models[type].primaryKey.name] = id;
		},

		deserializeAttributes: function(type, record, data){
			var modelSchema = this.schema.models[type];

			Object.keys(modelSchema.attributes).forEach(function(attr) {
				this.deserializeAttribute(type, record, attr, data);
			}, this);
		},

		deserializeAttribute: function(type, record, attr, data){
			var attrType = this.schema.models[type].attributes[attr].type;
			var transformation = transformations.lookupTransformation(attrType);
			var serialized = record[attr];
			var deserialized = transformation.deserialize(serialized);

			data[attr] = deserialized || null; // firebase doesn't like 'undefined' so replace with null
		},

		deserializeLinks: function(type, record, data){
			var _this = this;
			var modelSchema = this.schema.models[type];
			data.__rel = {};

			Object.keys(modelSchema.links).forEach(function(link) {
				var value;
				var linkDef = modelSchema.links[link];

				if(linkDef.type === "hasOne"){
					value = record[link];
				}
				else if(linkDef.type === "hasMany"){
					value = record[link] || {};
				}

				data.__rel[link] = value;
			});
		},

		buildHash: function(keys, value){
			var hash = {};

			keys.forEach(function(key){
				hash[key] = value;
			});

			return hash;
		},

		resourceKey: function(type) {
			return 'id';
		},

		resourceType: function(type) {
			return this.schema.pluralize(type);
		},

		resourceLink: function(type, link) {
			return link;
		},

		resourceAttr: function(type, attr) {
			return attr;
		}
	});

});
define('orbit-firebase/firebase-source', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit/lib/assert', 'orbit-common/source', 'orbit-firebase/lib/array-utils', 'orbit/transform-connector', 'orbit/operation', 'orbit-firebase/firebase-client', 'orbit-firebase/firebase-requester', 'orbit-firebase/firebase-transformer', 'orbit-firebase/firebase-serializer', 'orbit-firebase/firebase-listener', 'orbit-firebase/firebase-connector', 'orbit-firebase/cache-source', 'orbit-firebase/eager-relationship-loader', 'orbit-firebase/operation-matcher', 'orbit-firebase/operation-decomposer', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/operation-utils'], function (exports, objects, Orbit, assert, Source, array_utils, TransformConnector, Operation, FirebaseClient, FirebaseRequester, FirebaseTransformer, FirebaseSerializer, FirebaseListener, FirebaseConnector, CacheSource, EagerRelationshipLoader, OperationMatcher, OperationDecomposer, SchemaUtils, operation_utils) {

	'use strict';

	exports['default'] = Source['default'].extend({
		notifierName: "firebase-source",

		init: function(schema, options){
			var _this = this;
			options = options || {};

			this._super.apply(this, arguments);
			this._cache.maintainInverseLinks = false;

			assert.assert('FirebaseSource requires Orbit.Promise be defined', Orbit['default'].Promise);
			assert.assert('FirebaseSource requires Orbit.all be defined', Orbit['default'].all);
			assert.assert('FirebaseSource requires Orbit.map be defined', Orbit['default'].map);
			assert.assert('FirebaseSource requires Orbit.resolve be defined', Orbit['default'].resolve);
			assert.assert('FirebaseSource requires firebaseRef be defined', options.firebaseRef);

			var firebaseRef = options.firebaseRef;
			var serializer = new FirebaseSerializer['default'](schema);
			var firebaseClient = new FirebaseClient['default'](firebaseRef);

			this._firebaseTransformer = new FirebaseTransformer['default'](firebaseClient, schema, serializer);
			this._firebaseRequester = new FirebaseRequester['default'](firebaseClient, schema, serializer);
			this._firebaseListener = new FirebaseListener['default'](firebaseRef, schema, serializer);

			var cacheSource = new CacheSource['default'](this._cache);
			this._firebaseConnector = new FirebaseConnector['default'](this._firebaseListener, cacheSource);
			this.on("didTransform", function(operation){
				// console.log("fb.transmitting", operation.serialize());
			});
		},

		disconnect: function(){
			this._firebaseListener.unsubscribeAll();
		},

		_transform: function(operation){
			// console.log("fb.transform", operation.serialize());
			var _this = this;

			return this._firebaseTransformer.transform(operation).then(function(result){
				if(operation.op === "add" && operation.path.length === 2){
					var type = operation.path[0];
					_this._subscribeToRecords(type, result);
				}

				if(operation.op !== "remove" && operation.path.length === 2){
					operation.value = _this.schema.normalize(operation.path[0], operation.value);
				}

				_this._cache.transform(operation);
			});
		},

		_find: function(type, id, options){
			var _this = this;
			return this._firebaseRequester.find(type, id).then(function(records){
				if(!id) _this._firebaseListener.subscribeToType(type, null, options);

	      return _this._subscribeToRecords(type, records, options)
	      .then(function(){
	        return _this.settleTransforms();

	      })
	      .then(function(){
	        return records;

	      });
			});
		},

		_findLink: function(type, id, link){
			return this._firebaseRequester.findLink(type, id, link);
		},

		_findLinked: function(type, id, link, options){
			// console.log("fb._findLinked", arguments);
			var _this = this;
			var linkedType = this.schema.models[type].links[link].model;

			return this._firebaseRequester.findLinked(type, id, link).then(function(records){
				return _this._subscribeToRecords(linkedType, records, options)
				.then(function(){
					return _this.settleTransforms();

				})
				.then(function(){
					return records;

				});
			});
		},

		_subscribeToRecords: function(type, records, options){
			records = objects.isArray(records) ? records : [records];
			return this._firebaseListener.subscribeToRecords(type, array_utils.pluck(records, 'id'), options);
		}
	});

});
define('orbit-firebase/firebase-transformer', ['exports', 'orbit/lib/objects', 'orbit-firebase/transformers/add-record', 'orbit-firebase/transformers/remove-record', 'orbit-firebase/transformers/replace-attribute', 'orbit-firebase/transformers/add-to-has-many', 'orbit-firebase/transformers/add-to-has-one', 'orbit-firebase/transformers/remove-has-one', 'orbit-firebase/transformers/replace-has-many', 'orbit-firebase/transformers/remove-from-has-many', 'orbit-firebase/transformers/update-meta'], function (exports, objects, AddRecord, RemoveRecord, ReplaceAttribute, AddToHasMany, AddToHasOne, RemoveHasOne, ReplaceHasMany, RemoveFromHasMany, UpdateMeta) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer, cache){
			this._schema = schema;

			this._transformers = [
				new AddRecord['default'](firebaseClient, schema, serializer),
				new RemoveRecord['default'](firebaseClient),
				new ReplaceAttribute['default'](firebaseClient, schema),
				new AddToHasMany['default'](firebaseClient, schema),
				new AddToHasOne['default'](firebaseClient, schema),
				new RemoveHasOne['default'](firebaseClient, schema),
				new ReplaceHasMany['default'](firebaseClient, schema),
				new RemoveFromHasMany['default'](firebaseClient, schema),
				new UpdateMeta['default'](cache)
			];
		},

		transform: function(operation){
			this._normalizeOperation(operation);
			var transformer = this._findTransformer(operation);
			return transformer.transform(operation);
		},

	    _normalizeOperation: function(op) {
	      if (typeof op.path === 'string') {
	      	op.path = op.path.split('/');
	      }
	    },

		_findTransformer: function(operation){
			for(var i = 0; i < this._transformers.length; i++){
				var transformer = this._transformers[i];

				if(transformer.handles(operation)) {
					// console.log("using transformer", transformer);
					return transformer;
				}
			}

			throw new Error("Couldn't find a transformer for: " + JSON.stringify(operation));
		}
	});

});
define('orbit-firebase/lib/array-utils', ['exports'], function (exports) {

	'use strict';

	exports.removeItem = removeItem;
	exports.removeAt = removeAt;
	exports.map = map;
	exports.pluck = pluck;
	exports.any = any;

	function removeItem(array, condemned){
		return array.filter(function(item){
			return item !== condemned;
		});
	}

	function removeAt(array, index){
		var working = array.splice(0);
		working.splice(index, 1);
		return working;
	}

	function map(array, callback){
		var mapped = [];

		for(var i = 0; i < array.length; i++){
			mapped[i] = callback(array[i]);
		}

		return mapped;
	}

	function pluck(array, property){
		return map(array, function(item){
			return item[property];
		});
	}

	function any(array, callback){
		array.forEach(function(item){
			if (callback(item) ) return true;
		});

		return false;
	}

});
define('orbit-firebase/lib/cache-utils', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache){
			this.cache = cache;
		},

		retrieveLink: function(type, id, link) {
			var val = this.cache.retrieve([type, id, '__rel', link]);
			if (val !== null && typeof val === 'object') {
				val = Object.keys(val);
			}
			return val;
		},
	});

});
define('orbit-firebase/lib/object-utils', ['exports'], function (exports) {

	'use strict';

	exports.objectValues = objectValues;

	function objectValues(object){
		if(!object) return [];
		return Object.keys(object).map(function(key){
			return object[key];
		});
	}

});
define('orbit-firebase/lib/operation-utils', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/array-utils'], function (exports, objects, array_utils) {

	'use strict';

	exports.fop = fop;

	function formatOperation(operation){
		var formatted = {
			id: operation.id,
			op: operation.op,
			path: (typeof operation.path === 'string') ? operation.path : operation.path.join("/")
		};	

		if(operation.value) formatted.value = operation.value;

		return formatted;
	}

	function fop(operationOrOperations){
		if(objects.isArray(operationOrOperations)){
			return array_utils.reduce(operationOrOperations, function(operation){
				return formatOperation(operation);
			});
		}
		else {
			return formatOperation(operationOrOperations);
		}
	}

});
define('orbit-firebase/lib/schema-utils', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(schema){
			this.schema = schema;
		},

		lookupLinkDef: function(model, link){
			var modelSchema = this.schema.models[model];
			if(!modelSchema) throw new Error("Could not find model for " + model);
			var linkDef = modelSchema.links[link];
			if(!linkDef) throw new Error("Could not find type for " + model + "/" + link);
			return linkDef;
		},

		lookupRelatedLinkDef: function(model, link){
			var linkDef = this.lookupLinkDef(model, link);
			return this.schema.models[linkDef.model].links[linkDef.inverse];
		},

		linkTypeFor: function(model, link){
			return this.lookupLinkDef(model, link).type;
		},

		modelTypeFor: function(model, link){
			return this.lookupLinkDef(model, link).model;
		},

		modelSchema: function(type){
			var modelSchema = this.schema.models[type];
			if(!modelSchema) throw new Error("No model found for " + type);
			return modelSchema;
		}
	});

});
define('orbit-firebase/operation-decomposer', ['exports', 'orbit/lib/objects', 'orbit-firebase/operation-matcher', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/cache-utils', 'orbit/operation'], function (exports, objects, OperationMatcher, SchemaUtils, CacheUtils, Operation) {

	'use strict';

	function asHash(k,v){
	  var hash = {};
	  hash[k] = v;
	  return hash;
	}

	function buildObject(keys, value){
		var hash = {};
		keys.forEach(function(key){
			hash[key] = value;
		});
		return hash;
	}

	var ChangeDetails = objects.Class.extend({
		init: function(path, value, schema, cache){
			this.path = path;
			this.value = value;
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);		
			this.cache = cache;
		},

		model: function(){
			return this.path[0];
		},

		modelId: function(){
			return this.path[1];
		},

		link: function(){
			return this.path[3];
		},

		currentValue: function(){
			return this.cache.retrieve(this.path);
		},

		linkDef: function(){
			return this.schemaUtils.lookupLinkDef(this.model(), this.link());
		},

		originalInversePath: function(){
			return [this.linkDef().model, this.currentValue(), "__rel", this.linkDef().inverse];
		},

		inverseLinkDef: function(){
			return this.schemaUtils.lookupRelatedLinkDef(this.model(), this.link());
		},

		newInversePath: function(){
			return [this.linkDef().model, this.value, "__rel", this.linkDef().inverse];
		}
	});

	var RelationshipResolver = objects.Class.extend({
		init: function(schema, cache){
			this.visited = [];
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);
			this.cache = cache;
			this.cacheUtils = new CacheUtils['default'](cache);		
			this.operations = [];
		},

		visit: function(op, path, value){
			if(this.hasVisited(path)) return;
			this.markVisited(path);

			var linkType = this.schemaUtils.linkTypeFor(path[0], path[3]);

			if(!path[1]) throw new Error("invalid modelId: " + op + "|" + path + "|" + value);

			this[linkType][op].call(this, path, value);
		},

		hasVisited: function(path){
			return this.visited.indexOf(path.join("/")) !== -1;
		},

		markVisited: function(path){
			this.visited.push(path.join("/"));
		},

		hasOne: {
			add: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);

				this.operations.push(new Operation['default']({ op: 'add', path: changeDetails.path, value: changeDetails.value }));
				if(changeDetails.currentValue()){
					this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
				}
				this.visit("add", changeDetails.newInversePath(), changeDetails.modelId());
			},

			remove: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);
				if(!value) return;
				this.operations.push(new Operation['default']({ op: 'remove', path: changeDetails.path}));
				this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
			},

			replace: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);

				this.operations.push(new Operation['default']({ op: 'replace', path: changeDetails.path, value: changeDetails.value }));
				if(changeDetails.currentValue()){
					this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
				}
				this.visit("add", changeDetails.newInversePath(), changeDetails.modelId());
			}
		},

		hasMany: {
			add: function(path, value){

				var linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				var inversePath = [linkDef.model, value, "__rel", linkDef.inverse];

				this.operations.push(new Operation['default']({ op: 'add', path: path.concat(value), value: true }));
				this.visit("add", inversePath, path[1]);
			},

			remove: function(path, value){
				var linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				var inversePath = [linkDef.model, value, "__rel", linkDef.inverse];
				this.operations.push(new Operation['default']({ op: 'remove', path: path.concat(value) }));
				this.visit("remove", inversePath, path[1]);
			},

			replace: function(path, value){
				var _this = this,
					relatedLinkDef = this.schemaUtils.lookupRelatedLinkDef(path[0], path[3]);

				this.operations.push(new Operation['default']({ op: 'replace', path: path, value: buildObject(value, true) }));
				
				if(relatedLinkDef.type === 'hasMany') return;

				var linkValue = this.cache.retrieve(path),
					currentValue = linkValue ? Object.keys(linkValue) : [],
					modelId = path[1],
					linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				
				var added = value.filter(function(id){
					return currentValue.indexOf(id) === -1;
				});
				var removed = currentValue.filter(function(id){
					return value.indexOf(id) === -1;
				});

				added.forEach(function(id){
					var inversePath = [linkDef.model, id, "__rel", linkDef.inverse];
					_this.visit("add", inversePath, modelId);
				});

				removed.forEach(function(id){
					var inversePath = [linkDef.model, id, "__rel", linkDef.inverse];
					_this.visit("remove", inversePath, modelId);
				});
			}
		}
	});

	exports['default'] = objects.Class.extend({
		init: function(schema, cache){
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);
			this.cache = cache;
			this.cacheUtils = new CacheUtils['default'](cache);
		},

		decompose: function(operation){
			if(operation.path[2] !== "__rel") return [operation];
			var relationshipResolver = new RelationshipResolver(this.schema, this.cache);
			var normalized = this.normalize(operation);
			relationshipResolver.visit(normalized.op, normalized.path, normalized.value);
			return relationshipResolver.operations;
		},

		normalize: function(operation){
			var linkDef = this.schemaUtils.lookupLinkDef(operation.path[0], operation.path[3]);
			var path = operation.path;

			if(["hasMany", "hasOne"].indexOf(linkDef.type) === -1) throw new Error("unsupported link type: " + linkDef.type);

			if(linkDef.type === "hasOne" && operation.op === "add") return operation;
			if(linkDef.type === "hasOne" && operation.op === "remove"){
				return {
					op: operation.op, 
					path: path, 
					value: this.cache.retrieve(path)
				};
			}
			if(linkDef.type === "hasMany" && (['add', 'remove'].indexOf(operation.op) !== -1)) {
				return { 
					op: operation.op, 
					path: path.slice(0,-1), 
					value: path[path.length-1] 
				};
			}
			if(linkDef.type === "hasMany" && operation.op === "replace"){
				return {
					op: operation.op,
					path: operation.path,
					value: Object.keys(operation.value)	
				};
			}
			return operation;
		}
	});

});
define('orbit-firebase/operation-matcher', ['exports', 'orbit/lib/objects', 'orbit/lib/assert'], function (exports, objects, assert) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(operation, schema){
			assert.assert('OperationMatcher requires the operation', operation);
			assert.assert('OperationMatcher requires the schema', schema && schema.models);

			this.valueType = this._determineValueType(operation.path, schema);
			this.op = operation.op;
			this.schema = schema;
		},

		matches: function(op, valueType){
			return this.op === op && this.valueType === valueType;
		},

		_determineValueType: function(path, schema){
			if(path.length === 1) return 'type';
			if(path.length === 2) return 'record';
			if(path.length === 5) return 'link';
			if(path.length === 4 && path[2] === "__rel") return 'link';
			if(path[2].match(/^__/)) return "meta";

			var model = schema.models[path[0]];
			var key = path[2];
			if(model.attributes[key]) return 'attribute';
			if(model.keys[key]) return 'key';
			throw "Unable to determine value type at: " + path.join("/");
		},	
	});

});
define('orbit-firebase/subscriptions/attribute-subscription', ['exports', 'orbit/lib/objects', 'orbit/operation', 'orbit/main', 'orbit-firebase/transformations'], function (exports, objects, Operation, Orbit, transformations) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(path, listener){
			this.path = path;
			this.listener = listener;
			this.schema = listener._schema;
		},

		activate: function(){
			var _this = this,
				listener = this.listener,
				path = this.path,
				splitPath = this.path.split("/"),
				type = splitPath[0],
				recordId = splitPath[1],
				attribute = splitPath[2];

			return listener._enableListener(path, "value", function(snapshot){
				var splitPath = path.split('/');
				var model = splitPath[0];
				var attribute = splitPath[2];
				var attrType = _this.schema.models[model].attributes[attribute].type;
				var transformation = transformations.lookupTransformation(attrType);
				var serialized = snapshot.val();
				var deserialized = transformation.deserialize(serialized);

				listener._emitDidTransform(new Operation['default']({ op: 'replace', path: path, value: deserialized }));
			});
		},

		update: function(){
			return Orbit['default'].resolve();
		}
	});

});
define('orbit-firebase/subscriptions/has-many-subscription', ['exports', 'orbit/lib/objects', 'orbit/operation', 'orbit-firebase/lib/array-utils', 'orbit/main'], function (exports, objects, Operation, array_utils, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(path, listener){
			var splitPath = path.split('/');

			this._path = path;
			this._listener = listener;
			this._type = splitPath[0];
			this._recordId = splitPath[1];
			this._link = splitPath[2];
			this._linkType = listener._schemaUtils.modelTypeFor(this._type, this._link);
		},

		activate: function(){
			var _this = this;
			var listener = this._listener;
			var path = this._path;

			return this._addRecordListeners().then(function(){
				listener._enableListener(path, "child_added", _this._recordAdded.bind(_this));
				listener._enableListener(path, "child_removed", _this._recordRemoved.bind(_this));
			});
		},

		update: function(){
			return this._addRecordListeners();
		},

		_recordAdded: function(snapshot){
			// console.log("has-many.recordAdded");
			var options = this.options;
			var type = this._type;
			var recordId = this._recordId;
			var link = this._link;
			var listener = this._listener;
			var linkType = this._linkType;
			var linkId = snapshot.key();

			listener.subscribeToRecord(linkType, linkId, options).then(function(){
				listener._emitDidTransform(new Operation['default']({
					op: 'add',
					path: [type, recordId, '__rel', link, linkId].join("/"),
					value: snapshot.val()
				}));
			});
		},

		_recordRemoved: function(snapshot){
			var type = this._type;
			var	link = this._link;
			var recordId = this._recordId;
			var listener = this._listener;
			var	linkId = snapshot.key();

			listener._emitDidTransform(new Operation['default']({
				op: 'remove',
				path: [type, recordId, '__rel', link, linkId].join("/")
			}));
		},

		_addRecordListeners: function(){
			var _this = this;
			var path = this._path;
			var listener = this._listener;
			var linkType = this._linkType;

			return listener._firebaseClient.valueAt(path).then(function(linkValue){
				var recordIds = Object.keys(linkValue||{});

				var promises = array_utils.map(recordIds, function(recordId){
					return listener.subscribeToRecord(linkType, recordId, _this.options);
				});

				return Orbit['default'].all(promises);
			});
		},
	});

});
define('orbit-firebase/subscriptions/has-one-subscription', ['exports', 'orbit/lib/objects', 'orbit/operation', 'orbit/main'], function (exports, objects, Operation, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(path, listener){
			var splitPath = path.split("/");

			this._path = path;
			this._type = splitPath[0];
			this._recordId = splitPath[1];
			this._link = splitPath[2];
			this._listener = listener;
			this._linkType = listener._schemaUtils.modelTypeFor(this._type, this._link);
		},

		activate: function(){
			var _this = this;
			var listener = this._listener;
			var type = this._type;
			var recordId = this._recordId;
			var link = this._link;
			var options = this.options;
			var linkType = this._linkType;

			return listener._enableListener(this._path, "value", function(snapshot){
				var linkId = snapshot.val();

				return linkId ? _this._replaceLink(linkId) : _this._removeLink();
			});
		},

		update: function(){
			var _this = this;
			var listener = this._listener;
			var path = this._path;
			var linkType = this._linkType;

			return listener._firebaseClient.valueAt(path).then(function(linkValue){
				return listener.subscribeToRecord(linkType, linkValue, _this.options);
			});
		},

		_replaceLink: function(linkId){
			var listener = this._listener;
			var linkType = this._linkType;
			var options = this.options;
			var type = this._type;
			var link = this._link;
			var path = this._path;
			var recordId = this._recordId;
			var orbitPath = [type, recordId, '__rel', link].join("/");
			var replaceLinkOperation = new Operation['default']({op: 'replace', path: orbitPath, value: linkId});

			return listener.subscribeToRecord(linkType, linkId, options).then(function(){
				listener._emitDidTransform(replaceLinkOperation);
			});
		},

		_removeLink: function(){
			var listener = this._listener;
			var type = this._type;
			var recordId = this._recordId;
			var link = this._link;
			var orbitPath = [type, recordId, '__rel', link].join("/");
			var removeLinkOperation = new Operation['default']({op: 'remove', path: orbitPath});

			listener._emitDidTransform(removeLinkOperation);
		}
	});

});
define('orbit-firebase/subscriptions/options', ['exports', 'orbit/lib/objects'], function (exports, objects) {

  'use strict';

  exports.buildOptions = buildOptions;

  var Options = objects.Class.extend({
  	init: function(optionsHash){
      this.include = optionsHash.include;
  	},

    currentIncludes: function(){
      return Object.keys(this.include||{});
    },

    forLink: function(link){
      var linkOptions = objects.clone(this);
      linkOptions.include = this.include[link];
      return new Options(linkOptions);
    }
  });

  function buildOptions(optionsHash){
    if(optionsHash instanceof Options) return optionsHash;

    optionsHash = optionsHash || {};
    var include = parseInclude(optionsHash.include);

    return new Options({include: include});
  }

  function parseInclude(include){
    if (!include) return undefined;
    if (!objects.isArray(include)) {
      include = [include];
    }

    var parsed = {};

    include.forEach(function(inclusion){
      var current = parsed;
      inclusion.split(".").forEach(function(link){
        current[link] = current[link] || {};
        current = current[link];
      });
    });

    return parsed;
  }

});
define('orbit-firebase/subscriptions/record-subscription', ['exports', 'orbit/lib/objects', 'orbit/operation', 'orbit/main'], function (exports, objects, Operation, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(path, listener){
			this.path = path;
			this.listener = listener;
		},

		activate: function(){
			var listener = this.listener;
			var path = this.path;
			var splitPath = this.path.split("/");
			var type = splitPath[0];
			var recordId = splitPath[1];
			var modelSchema = listener._schemaUtils.modelSchema(type);
			var options = this.options;

			var attributePromises = Object.keys(modelSchema.attributes).map(function(attribute){
				return listener._subscribeToAttribute(type, recordId, attribute);
			});

			var linkSubscriptionPromises = options.currentIncludes().map(function(link){
				return listener._subscribeToLink(type, recordId, link, options.forLink(link));
			});

			var dependencyPromises = Orbit['default'].all([
				Orbit['default'].all(attributePromises),
				Orbit['default'].all(linkSubscriptionPromises)
			]);

			return dependencyPromises.then(function(){
				return listener._enableListener(path, "value", function(snapshot){
					var value = snapshot.val();

					if(value){
						var deserializedRecord = listener._serializer.deserialize(type, recordId, snapshot.val());
						listener._emitDidTransform(new Operation['default']({ op: 'add', path: path, value: deserializedRecord }) );
					} else {
						listener._emitDidTransform(new Operation['default']({ op: 'remove', path: path }));
					}

				});
			});
		},

		update: function(){
			return this.activate();
		}
	});

});
define('orbit-firebase/transformations', ['exports'], function (exports) {

  'use strict';

  exports.lookupTransformation = lookupTransformation;

  var transformations = {
    date: {
      serialize: function(value){
        return value && value.getTime();
      },

      deserialize: function(serialized){
        return serialized && new Date(serialized);
      }
    },

    defaultTransformation: {
      serialize: function(value){
        return value;
      },

      deserialize: function(serialized){
        return serialized;
      }
    },
  };

  function lookupTransformation(attrType){
    return transformations[attrType] || transformations.defaultTransformation;
  }

});
define('orbit-firebase/transformers/add-record', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer){
			this._firebaseClient = firebaseClient;
			this._schema = schema;
			this._serializer = serializer;
		},

		handles: function(operation){
			return operation.op === "add" && operation.path.length === 2;
		},

		transform: function(operation){
			var model = operation.path[0];
			var record = this._schema.normalize(model, operation.value);
			var serializedRecord = this._serializer.serializeRecord(model, record);

			return this._firebaseClient.set(operation.path, serializedRecord);
		}
	});

});
define('orbit-firebase/transformers/add-to-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return; 
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "add" && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.set(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/add-to-has-one', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return ["add", "replace"].indexOf(operation.op) !== -1 && path[2] === '__rel' && linkType === 'hasOne';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.set(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/remove-from-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "remove" && path[2] === '__rel' && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.remove(path);
		}
	});

});
define('orbit-firebase/transformers/remove-has-one', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "remove" && path[2] === '__rel' && linkType === 'hasOne';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.remove(path);
		}
	});

});
define('orbit-firebase/transformers/remove-record', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient){
			this._firebaseClient = firebaseClient;
		},

		handles: function(operation){
			return operation.op === "remove" && operation.path.length === 2;
		},

		transform: function(operation){
			return this._firebaseClient.set(operation.path, null);
		}
	});

});
define('orbit-firebase/transformers/replace-attribute', ['exports', 'orbit/lib/objects', 'orbit-firebase/transformations'], function (exports, objects, transformations) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
	    this._schema = schema;
		},

		handles: function(operation){
			return ["replace", "add"].indexOf(operation.op) !== -1 && operation.path.length === 3 && !operation.path[2].match(/^__/);
		},

		transform: function(operation){
	    var model = operation.path[0];
	    var attr = operation.path[2];
	    var value = operation.value;
	    var attrType = this._schema.models[model].attributes[attr].type;
	    var transformation = transformations.lookupTransformation(attrType);
	    var serialized = transformation.serialize(value);

			return this._firebaseClient.set(operation.path, serialized);
		}
	});

});
define('orbit-firebase/transformers/replace-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "replace" && path[2] === '__rel' && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.set(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/update-meta', ['exports', 'orbit/lib/objects', 'orbit/main'], function (exports, objects, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache){
			this._cache = cache;
		},

		handles: function(operation){
			return operation.path[2].match(/^__/);
		},

		transform: function(operation){
			console.log("applying to cache", operation);
			this._cache.transform(operation);				
			console.log("applied to cache", operation);
			return Orbit['default'].resolve();
		}
	});

});//# sourceMappingURL=orbit-firebase.amd.map