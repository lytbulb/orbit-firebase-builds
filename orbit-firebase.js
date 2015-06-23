(function() {

// Share loader properties from globalized Orbit package
var define = window.Orbit.__define__;
var requireModule = window.Orbit.__requireModule__;
var require = window.Orbit.__require__;
var requirejs = window.Orbit.__requirejs__;

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
define('orbit-firebase/firebase-client', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit-firebase/lib/array-utils'], function (exports, objects, Orbit, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef){
			this.firebaseRef = firebaseRef;
		},

		authenticateAdmin: function(secret){
			return this._authenticate(secret);
		},

		authenticateUser: function(secret, userDetails){
			var tokenGenerator = new FirebaseTokenGenerator(secret);
	    var userToken = tokenGenerator.createToken(userDetails);
	    return this._authenticate(userToken);
		},

		_authenticate: function(token){
			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.authWithCustomToken(token, function(error){
					if(error){
						reject(error);
					}
					else {
						resolve();
					}
				});
			});
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
			return new Orbit['default'].Promise(function(resolve, reject){
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
					reject(error);
				});
			});
		},

		removeFromArray: function(arrayPath, value){
			var _this = this;

			return this.valueAt(arrayPath).then(function(array){
				if(!array) return;

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
define('orbit-firebase/firebase-listener', ['exports', 'orbit/lib/objects', 'orbit/lib/eq', 'orbit/lib/assert', 'orbit/evented', 'orbit-firebase/lib/schema-utils', 'orbit/operation', 'orbit-firebase/firebase-client', 'orbit/main', 'orbit-firebase/lib/array-utils', 'orbit-firebase/subscriptions/record-subscription', 'orbit-firebase/subscriptions/attribute-subscription', 'orbit-firebase/subscriptions/has-many-subscription', 'orbit-firebase/subscriptions/has-one-subscription', 'orbit-firebase/subscriptions/options', 'orbit-firebase/lib/object-utils', 'orbit-firebase/mixins/invocations-tracker'], function (exports, objects, eq, assert, Evented, SchemaUtils, Operation, FirebaseClient, Orbit, array_utils, RecordSubscription, AttributeSubscription, HasManySubscription, HasOneSubscription, subscriptions__options, object_utils, InvocationsTracker) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef, schema, serializer){
			Evented['default'].extend(this);
			InvocationsTracker['default'].extend(this);
			window.firebaseListener = this;

			this._firebaseRef = firebaseRef;
			this._firebaseClient = new FirebaseClient['default'](this._firebaseRef);
			this._schema = schema;
			this._schemaUtils = new SchemaUtils['default'](schema);
			this._serializer = serializer;

			this._listeners = {};
			this._listenerInitializers = {};
			this._subscriptions = {};

			this._addSubscription = this._trackInvocations(this._addSubscription);
		},

		subscribeToType: function(type, _, subscriptionOptions){
			var _this = this;
			var typeRef = this._firebaseRef.child('type');
			subscriptionOptions = subscriptions__options.buildOptions(subscriptionOptions);

			this._enableListener(type, 'child_added', function(snapshot){
				var record = snapshot.val();
				_this.subscribeToRecord(type, record.id, subscriptionOptions);
			});
		},

		subscribeToRecords: function(type, ids, options){
			var _this = this;
			var promises = array_utils.map(ids, function(id){
				return _this.subscribeToRecord(type, id, options);
			});

			return this._settleAllPermitted(promises);
		},

		_settleAllPermitted: function(promises){
			return new Orbit['default'].Promise(function(resolve, reject){
				return Orbit['default'].allSettled(promises).then(function(settled){
					var values = [];

					settled.forEach(function(promiseResult){
						if(promiseResult.state === 'rejected'){
							if(promiseResult.reason.code === 'PERMISSION_DENIED'){
								// filter out values that have access denied
							}
							else {
								throw new Error(promiseResult.reason);
							}
						}
						else if(promiseResult.state === 'fulfilled'){
							values.push(promiseResult.value);
						}
					});
					resolve(values);
				});
			});
		},

		subscribeToRecord: function(type, id, subscriptionOptions){
			var path = [type, id].join("/");
			subscriptionOptions = subscriptions__options.buildOptions(subscriptionOptions);

			return this._addSubscription(path, RecordSubscription['default'], subscriptionOptions);
		},

		subscriptions: function(){
			return Object.keys(this._subscriptions);
		},

		hasActiveSubscription: function(subscriptionPath){
			var subscription = this._subscriptions[subscriptionPath];
			return subscription && subscription.status === 'active';
		},

		unsubscribeAll: function(){
			var _this = this;

			return this.then(function(){
				Object.keys(_this._listeners).forEach(function(listenerKey){
					var path = listenerKey.split(":")[0];
					var eventType = listenerKey.split(":")[1];
					var callback = _this._listeners[listenerKey];

					_this._disableListener(path, eventType, callback);
				});
			});
		},

		_subscribeToAttribute: function(type, id, attribute){
			var path = [type, id, attribute].join("/");
			return this._addSubscription(path, AttributeSubscription['default']);
		},

		subscribeToLink: function(type, id, link, options){
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
			var _this = this;
			var path = [type, id, link].join("/");

			return this._addSubscription(path, HasOneSubscription['default'], options);
		},

		findSubscription: function(path){
			return this._subscriptions[path];
		},

		_subscribeToHasMany: function(type, id, link, options){
			var _this = this;
			var path = [type, id, link].join("/");

			return this._addSubscription(path, HasManySubscription['default'], options);
		},

		_addSubscription: function(path, SubscriptionClass, subscriptionOptions){
			subscriptionOptions = subscriptions__options.buildOptions(subscriptionOptions);
			var _this = this;
			var subscription = this.findSubscription(path);

			if(!subscription) {
				subscription = this._createSubscription(SubscriptionClass, path);
				this._subscriptions[path] = subscription;
			}

			return subscription.enqueue(function(){
				var promise;

				if(subscription.status === 'permission_denied') promise = Orbit['default'].resolve(subscription);
				else if(subscription.status === 'new') promise = _this._activateSubscription(subscription, subscriptionOptions);
				else promise = _this._updateSubscription(subscription, subscriptionOptions);

				return promise.then(function(){
					return subscription;
				});

			}).catch(function(error){
				subscription.status = error.code === "PERMISSION_DENIED" ? "permission_denied" : "error";

				if(subscription.status !== "permission_denied") throw error;

				return subscription;

			});
		},

		_createSubscription: function(SubscriptionClass, path, options){
			var subscription = new SubscriptionClass(path, this);
			subscription.status = "new";
			return subscription;
		},

		_activateSubscription: function(subscription, options){
			subscription.options = options;
			subscription.status = "activating";

			return subscription.activate().then(
				function(){
					subscription.status = "active";
					return subscription;

				});
		},

		_updateSubscription: function(subscription, options){
			var mergedOptions = this._mergeOptions(subscription.options, options);
			if(!eq.eq(mergedOptions, subscription.options)){
				subscription.options = options;
				return subscription.update();
			}
			else {
				return Orbit['default'].resolve();
			}
		},

		_mergeOptions: function(current, requested){
			return object_utils.deepMerge(current, requested);
		},

		_emitDidTransform: function(operation){
			this.emit("didTransform", operation);
		},

		_enableListener: function(path, eventType, callback){
			var _this = this;
			path = (typeof path === 'string') ? path : path.join('/');
			var key = this._buildListenerKey(path, eventType);

			if(!this._listenerInitializers[key]){
				this._listenerInitializers[key] = new Orbit['default'].Promise(function(resolve, reject){
					var wrappedCallback = function(){
						resolve(callback.apply(_this, arguments));
					};

					_this._listeners[key] = wrappedCallback;
					_this._firebaseRef.child(path).on(eventType, wrappedCallback, function(error){
						delete _this._listeners[key];
						reject(error);
					});
				});
			}

			return this._listenerInitializers[key];
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
				return _this._serializer.deserializeRecords(type, records);
			});
		},

		_findLinkedHasMany: function(type, id, link){
			var _this = this;
			var linkDef = this._schemaUtils.lookupLinkDef(type, link);
			var model = linkDef.model;

			return this.findLink(type, id, link).then(function(ids){
				var promised = [];
				for(var i = 0; i < ids.length; i++){
					promised[i] = _this._firebaseClient.valueAt([model, ids[i]]);
				}

				return _this._settleAllPermitted(promised).then(function(serialized){
					return array_utils.map(serialized, function(record){
						return _this._serializer.deserialize(model, record.id, record);
					});
				});
			});
		},

		_settleAllPermitted: function(promises){
			return new Orbit['default'].Promise(function(resolve, reject){
				Orbit['default'].allSettled(promises).then(function(settled){
					var values = [];

					settled.forEach(function(promiseResult){
						if(promiseResult.state === 'rejected'){
							if(promiseResult.reason.code === 'PERMISSION_DENIED'){
								// filter out values that have access denied
							}
							else {
								throw new Error(promiseResult.reason);
							}
						}
						else if(promiseResult.state === 'fulfilled'){
							values.push(promiseResult.value);
						}
					});

					resolve(values);
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
define('orbit-firebase/firebase-serializer', ['exports', 'orbit-common/serializer', 'orbit/lib/objects', 'orbit/lib/assert', 'orbit-firebase/transformations', 'orbit/main', 'orbit-common/main'], function (exports, Serializer, objects, assert, transformations, Orbit, OC) {

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

				if(value === OC['default'].LINK_NOT_INITIALIZED) throw new Error("Can't save " + type + "/" + record.id + " with " + link + " not loaded");

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

			return this.schema.normalize(type, data, {initializeLinks: false});
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

			// links are only added by link subscriptions - this allows the permissions to be checked before adding them to the record
			Object.keys(modelSchema.links).forEach(function(link) {
				data.__rel[link] = OC['default'].LINK_NOT_INITIALIZED;
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
define('orbit-firebase/firebase-source', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit-common/main', 'orbit/lib/assert', 'orbit-common/source', 'orbit-firebase/lib/array-utils', 'orbit/operation', 'orbit-firebase/firebase-client', 'orbit-firebase/firebase-requester', 'orbit-firebase/firebase-transformer', 'orbit-firebase/firebase-serializer', 'orbit-firebase/firebase-listener', 'orbit-firebase/cache-source', 'orbit-firebase/operation-matcher', 'orbit-firebase/operation-decomposer', 'orbit-firebase/operation-sequencer', 'orbit-common/operation-encoder', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/operation-utils'], function (exports, objects, Orbit, OC, assert, Source, array_utils, Operation, FirebaseClient, FirebaseRequester, FirebaseTransformer, FirebaseSerializer, FirebaseListener, CacheSource, OperationMatcher, OperationDecomposer, OperationSequencer, OperationEncoder, SchemaUtils, operation_utils) {

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
			assert.assert('FirebaseSource requires Orbit.allSettled be defined', Orbit['default'].allSettled);
			assert.assert('FirebaseSource requires Orbit.map be defined', Orbit['default'].map);
			assert.assert('FirebaseSource requires Orbit.resolve be defined', Orbit['default'].resolve);
			assert.assert('FirebaseSource requires firebaseRef be defined', options.firebaseRef);

			var firebaseRef = options.firebaseRef;
			var serializer = new FirebaseSerializer['default'](schema);
			var firebaseClient = new FirebaseClient['default'](firebaseRef);

			this._schemaUtils = new SchemaUtils['default'](this.schema);
			this._firebaseTransformer = new FirebaseTransformer['default'](firebaseClient, schema, serializer);
			this._firebaseRequester = new FirebaseRequester['default'](firebaseClient, schema, serializer);
			this._firebaseListener = new FirebaseListener['default'](firebaseRef, schema, serializer);

			var cacheSource = new CacheSource['default'](this._cache);
			this._operationSequencer = new OperationSequencer['default'](this._cache, schema);

			this._firebaseListener.on('didTransform', function(operation){
				_this._operationSequencer.process(operation);
			});

			this._operationEncoder = new OperationEncoder['default'](schema);

			this.on("didTransform", function(operation){
				// console.log("fb.transmitting", operation.path.join("/"), operation.value);
			});
		},

		disconnect: function(){
			return this._firebaseListener.unsubscribeAll();
		},

		_transform: function(operation){
			// console.log("fb.transform", operation.serialize());
			var _this = this;

			if(this._isIgnoredOperation(operation)) return Orbit['default'].resolve();

			return this._firebaseTransformer.transform(operation).then(function(result){

				if(operation.op === "add" && operation.path.length === 2){
					var type = operation.path[0];
					var allLinks = _this._schemaUtils.linksFor(type);
					_this._subscribeToRecords(type, result, {include: allLinks});
					return _this._firebaseListener;
				}

				else if(operation.op !== "remove" && operation.path.length === 2){
					operation.value = _this.schema.normalize(operation.path[0], operation.value);
				}

			}).then(function(){
				_this._operationSequencer.process(operation);
			});
		},

		_isIgnoredOperation: function(operation){
			var operationType = this._operationEncoder.identify(operation);

			switch(operationType){
				case 'addHasOne':
				case 'replaceHasOne':
				case 'addHasMany':
				case 'replaceHasMany':
					return operation.value === OC['default'].LINK_NOT_INITIALIZED;

				default: return false;
			}
		},

		_find: function(type, id, options){
			var _this = this;
			return this._firebaseRequester.find(type, id).then(function(records){
				if(!id) _this._firebaseListener.subscribeToType(type, null, options);
				_this._subscribeToRecords(type, records, options);

	      return _this._firebaseListener.then(function(){
	        return _this.settleTransforms();
	      })
	      .then(function(){
	        return records;

	      });
			});
		},

		_findLink: function(type, id, link){
			// todo - why are no subscriptions created? maybe irrelevant
			return this._firebaseRequester.findLink(type, id, link);
		},

		_findLinked: function(type, id, link, options){
			// console.log("fb._findLinked", arguments);
			var _this = this;
			var linkedType = this.schema.models[type].links[link].model;

			return this._firebaseRequester.findLinked(type, id, link).then(function(records){
				_this._firebaseListener.subscribeToLink(type, id, link, options);
				return _this._firebaseListener.then(function(){
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
			this._firebaseClient = firebaseClient;

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
			var _this = this;
			this._normalizeOperation(operation);

			var transformer = this._findTransformer(operation);
			return transformer.transform(operation).then(function(result){
				return _this._firebaseClient.push('operation', operation.serialize()).then(function(){
					return result;
				});
			});
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
	exports.arrayToHash = arrayToHash;

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
	  var item;

	  for(var i = 0; i < array.length; i++){
	    item = array[i];
	    if (callback(item) ) return true;
	  }

		return false;
	}

	function arrayToHash(array, value){
	  var hash = {};

	  array.forEach(function(item){
	    hash[item] = value;
	  });

	  return hash;
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
  exports.deepMerge = deepMerge;
  exports.asHash = asHash;

  function objectValues(object){
  	if(!object) return [];
  	return Object.keys(object).map(function(key){
  		return object[key];
  	});
  }

  function deepMerge(target, src) {
    var array = Array.isArray(src);
    var dst = array && [] || {};

    if (array) {
      target = target || [];
      dst = dst.concat(target);
      src.forEach(function(e, i) {
        if (typeof dst[i] === 'undefined') {
          dst[i] = e;
        } else if (typeof e === 'object') {
          dst[i] = deepMerge(target[i], e);
        } else {
          if (target.indexOf(e) === -1) {
            dst.push(e);
          }
        }
      });
    } else {
      if (target && typeof target === 'object') {
        Object.keys(target).forEach(function(key) {
          dst[key] = target[key];
        });
      }
      Object.keys(src).forEach(function(key) {
        if (typeof src[key] !== 'object' || !src[key]) {
          dst[key] = src[key];
        } else {
          if (!target[key]) {
            dst[key] = src[key];
          } else {
            dst[key] = deepMerge(target[key], src[key]);
          }
        }
      });
    }

    return dst;
  }

  function asHash(k,v){
    var hash = {};
    hash[k] = v;
    return hash;
  }

});
define('orbit-firebase/lib/operation-utils', ['exports', 'orbit/lib/objects', 'orbit-firebase/lib/array-utils'], function (exports, objects, array_utils) {

	'use strict';

	exports.fop = fop;
	exports.operationToString = operationToString;

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

	function operationToString(operation){
		return [operation.op, operation.path.join("/"), operation.value].join(":");
	}

});
define('orbit-firebase/lib/promise-utils', ['exports'], function (exports) {

  'use strict';

  exports.timeoutPromise = timeoutPromise;

  /* global clearTimeout */

  function timeoutPromise(promise, label, ms){
    if(!promise || !promise.then) console.error("Not a promise", label);

    ms = ms || 2000;
    var timeout = setTimeout(function(){
      console.log(label);
    }, ms);

    return promise.then(function(result){
      clearTimeout(timeout);
      return result;
    });
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
		},

		linksFor: function(model){
			return Object.keys(this.modelSchema(model).links);
		},

		inverseLinkFor: function(model, link){
			return this.lookupLinkDef(model, link).inverse;
		}
	});

});
define('orbit-firebase/mixins/invocations-tracker', ['exports', 'orbit/main', 'orbit/lib/assert', 'orbit/lib/objects', 'orbit/evented'], function (exports, Orbit, assert, objects, Evented) {

  'use strict';

  var InvocationsTracker = {

    extend: function(object) {
      Evented['default'].extend(object);

      if (object._invocationsTracker === undefined) {
        objects.extend(object, this.interface);
        object._invocations = [];
      }
      return object;
    },

    interface: {
      _invocationsTracker: true,

      _trackInvocations: function(callback){
        var invocations = this._invocations;
        var _this = this;

        return function(){
          var args = arguments;
          var promise = callback.apply(_this, args);
          invocations.push(promise);

          return promise.finally(function(){
            var index = invocations.indexOf(promise);

            if (index > -1) {
              invocations.splice(index, 1);
            }

            if(invocations.length === 0){
              _this.emit("_clearedInvocations");
            }
          });
        };
      },

      then: function(callback){
        var _this = this;

        return new Orbit['default'].Promise(function(resolve, reject){
          if(_this._invocations.length === 0) resolve(callback());
          else _this.one("_clearedInvocations", function(){
            resolve(callback());
          });
        });
      }
    }
  };

  exports['default'] = InvocationsTracker;

});
define('orbit-firebase/operation-decomposer', ['exports', 'orbit/lib/objects', 'orbit-firebase/operation-matcher', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/cache-utils', 'orbit/operation', 'orbit-firebase/lib/object-utils'], function (exports, objects, OperationMatcher, SchemaUtils, CacheUtils, Operation, object_utils) {

	'use strict';

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
define('orbit-firebase/operation-sequencer', ['exports', 'orbit/evented', 'orbit/lib/objects', 'orbit/main', 'orbit-firebase/lib/schema-utils'], function (exports, Evented, objects, Orbit, SchemaUtils) {

  'use strict';

  exports['default'] = objects.Class.extend({
    init: function(cache, schema){
      window.operationSequencer = this;
      Evented['default'].extend(this);
      this._cache = cache;
      this._schema = schema;
      this._schemaUtils = new SchemaUtils['default'](schema);
      this._dependents = {};
      this._dependencies = {};
    },

    process: function(operation){
      if(this._isRedundent(operation)) return;

      var requiredPaths = this._requiredPathsFor(operation);
      var missingPaths = this._withoutExistingPaths(requiredPaths);

      if(missingPaths.length > 0){
        this._deferOperation(operation, missingPaths);
      }
      else {
        this._emit(operation);
      }
    },

    _emit: function(operation){
      this._cache.transform(operation);
      this._triggerOperationsDependentOn(operation);
    },

    _isRedundent: function(operation){
      var recordPath = [operation.path[0], operation.path[1]].join("/");
      var record = this._cache.retrieve(recordPath);

      if(record && operation.path.length === 2 && operation.op !== 'remove') return true;
      if(!record && operation.path.length === 3) return true;
      return false;
    },

    _requiredPathsFor: function(operation){
      if (this._isRecordOp(operation)) return [];

      var recordPath = this._getRecordPath(operation);
      if (this._isModifyAttributeOp(operation)) return [recordPath];
      if (this._isModifyHasOneOp(operation)) return [recordPath];
      if (this._isInitializeHasManyOp(operation)) return [recordPath];

      var relatedRecordPath = this._getRelatedRecordPath(operation);
      var linkPath = this._getLinkPath(operation);
      if (this._isModifyHasManyOp(operation)) return [recordPath, relatedRecordPath, linkPath];

      return [];
    },

    _withoutExistingPaths: function(paths){
      var cache = this._cache;

      return paths.filter(function(path){

        var pathValue = cache.retrieve(path);
        return !pathValue || pathValue === Orbit['default'].LINK_NOT_INITIALIZED;

      });
    },

    _deferOperation: function(operation, paths){
      var _this = this;

      paths.forEach(function(path){
        _this._addPathDependency(operation, path);
      });
    },

    _addPathDependency: function(operation, path){
      var operationPath = operation.path.join("/");
      this._dependents[path] = this._dependents[path] || [];
      this._dependencies[operationPath] = this._dependencies[operationPath] || {};
      this._dependents[path].push(operation);
      this._dependencies[operationPath][path] = true;
    },

    _triggerOperationsDependentOn: function(operation){
      var _this = this;
      var path = operation.path.join("/");
      var dependents = this._dependents[path];

      if(!dependents) {
        return;
      }

      for(var i = 0; i < dependents.length; i++){
        var dependentOperation = dependents[i];
        var dependentOperationPath = dependentOperation.path.join("/");

        delete _this._dependencies[dependentOperationPath][path];

        if(Object.keys(_this._dependencies[dependentOperationPath]).length === 0) {
          this._emit(dependentOperation);
        }
      }

      delete this._dependents[path];
    },

    _isRecordOp: function(operation){
      return operation.path.length === 2;
    },

    _isInitializeHasManyOp: function(operation){
      var path = operation.path;
      return path.length === 4 && this._schema.linkDefinition(path[0], path[3]).type === 'hasMany';
    },

     _isModifyHasOneOp: function(operation){
      var path = operation.path;
      return this._schema.linkDefinition(path[0], path[3]).type === 'hasOne' && path.length === 4;
    },

    _isModifyAttributeOp: function(operation){
      return operation.path.length === 3;
    },

    _isModifyHasManyOp: function(operation){
      var path = operation.path;
      return this._schema.linkDefinition(path[0], path[3]).type === 'hasMany' && path.length > 4;
    },

    _getRecordPath: function(operation){
      return [operation.path[0], operation.path[1]].join("/");
    },

    _getRelatedRecordPath: function(operation){
      var recordType = operation.path[0];
      var linkName = operation.path[3];
      var linkedType = this._schema.linkDefinition(recordType, linkName).model;
      var linkedId = operation.path.length === 5 ? operation.path[4] : operation.value;
      return [linkedType, linkedId].join("/");
    },

    _getLinkPath: function(operation){
      return operation.path.slice(0, 4).join("/");
    }
  });

});
define('orbit-firebase/subscriptions/attribute-subscription', ['exports', 'orbit-firebase/subscriptions/subscription', 'orbit/operation', 'orbit/main', 'orbit-firebase/transformations'], function (exports, Subscription, Operation, Orbit, transformations) {

	'use strict';

	exports['default'] = Subscription['default'].extend({
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
				return Orbit['default'].resolve();
			});
		},

		update: function(){
			return Orbit['default'].resolve();
		}
	});

});
define('orbit-firebase/subscriptions/has-many-subscription', ['exports', 'orbit-firebase/subscriptions/subscription', 'orbit/operation', 'orbit-firebase/lib/array-utils', 'orbit/main'], function (exports, Subscription, Operation, array_utils, Orbit) {

	'use strict';

	exports['default'] = Subscription['default'].extend({
		init: function(path, listener){
			var splitPath = path.split('/');

			this.path = path;
			this._listener = listener;
			this._type = splitPath[0];
			this._recordId = splitPath[1];
			this._link = splitPath[2];
			this._inverseLink = listener._schemaUtils.inverseLinkFor(this._type, this._link);
			this._linkType = listener._schemaUtils.modelTypeFor(this._type, this._link);
		},

		activate: function(){
			var _this = this;
			var listener = this._listener;
			var path = this.path;
			var type = this._type;
			var recordId = this._recordId;
			var link = this._link;
			var splitPath = path.split("/");
			var orbitPath = [splitPath[0], splitPath[1], '__rel', splitPath[2]].join("/");

			return this._addRecordListeners().then(function(allowedRecordIds){
				listener._emitDidTransform(new Operation['default']({
					op: 'add',
					path: orbitPath,
					value: array_utils.arrayToHash(allowedRecordIds, true)
				}));
			}).then(function(){
				listener._enableListener(path, "child_added", _this._recordAdded.bind(_this));
				listener._enableListener(path, "child_removed", _this._recordRemoved.bind(_this));
			});
		},

		update: function(){
			return this._addRecordListeners();
		},

		_recordAdded: function(snapshot){
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
					value: true
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
			var path = this.path;
			var listener = this._listener;
			var linkType = this._linkType;
			var options = this._inverseLink ? this.options.addInclude(this._inverseLink) : this.options;

			return listener._firebaseClient.valueAt(path).then(function(linkValue){
				var recordIds = Object.keys(linkValue||{});

				return listener.subscribeToRecords(linkType, recordIds, options).then(function(){
					return recordIds.filter(function(recordId){
						return listener.hasActiveSubscription([linkType, recordId].join("/"));
					});
				});
			});
		}
	});

});
define('orbit-firebase/subscriptions/has-one-subscription', ['exports', 'orbit-firebase/subscriptions/subscription', 'orbit/operation', 'orbit/main'], function (exports, Subscription, Operation, Orbit) {

	'use strict';

	exports['default'] = Subscription['default'].extend({
		init: function(path, listener){
			var splitPath = path.split("/");

			this.path = path;
			this._type = splitPath[0];
			this._recordId = splitPath[1];
			this._link = splitPath[2];
			this._inverseLink = listener._schemaUtils.inverseLinkFor(this._type, this._link);
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

			return listener._enableListener(this.path, "value", function(snapshot){
				var linkId = snapshot.val();

				return linkId ? _this._replaceLink(linkId) : _this._removeLink();
			});
		},

		update: function(){
			var _this = this;
			var listener = this._listener;
			var path = this.path;
			var linkType = this._linkType;

			return listener._firebaseClient.valueAt(path).then(function(linkValue){
				return listener.subscribeToRecord(linkType, linkValue, _this.options);
			});
		},

		_replaceLink: function(linkId){
			var _this = this;
			var listener = this._listener;
			var linkType = this._linkType;
			var options = this.options;
			var type = this._type;
			var link = this._link;
			var path = this.path;
			var recordId = this._recordId;
			var orbitPath = [type, recordId, '__rel', link].join("/");

			return listener.subscribeToRecord(linkType, linkId, options).then(function(subscription){
				if(subscription.status === "permission_denied") return;
				_this._emitOperation(orbitPath, linkId);
			});
		},

		_removeLink: function(){
			var listener = this._listener;
			var type = this._type;
			var recordId = this._recordId;
			var link = this._link;
			var orbitPath = [type, recordId, '__rel', link].join("/");

			this._emitOperation(orbitPath, null);
		},

		_emitOperation: function(path, value){
			var op = this.linkInitialized ? 'replace' : 'add';
			this.linkInitialized = true;
			this._listener._emitDidTransform(new Operation['default']({op: op, path: path, value: value||null}));
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
    },

    addInclude: function(link){
      if(!link) throw new Error("link not specified");
      var options = objects.clone(this);
      if(!options.include) options.include = {};
      options.include[link] = {};
      return new Options(options);
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
define('orbit-firebase/subscriptions/record-subscription', ['exports', 'orbit-firebase/subscriptions/subscription', 'orbit/operation', 'orbit/main', 'orbit-firebase/transformations'], function (exports, Subscription, Operation, Orbit, transformations) {

	'use strict';

	exports['default'] = Subscription['default'].extend({
		init: function(path, listener){
			this.path = path;
			this.listener = listener;
			var splitPath = this.path.split("/");
			this.type = splitPath[0];
			this.recordId = splitPath[1];
			this.modelSchema = listener._schemaUtils.modelSchema(this.type);
		},

		activate: function(){
			var _this = this;
			var listener = this.listener;
			var path = this.path;
			var type = this.type;
			var recordId = this.recordId;
			var modelSchema = this.modelSchema;
			var options = this.options;

			return listener._enableListener(path, "value", function(snapshot){
				_this.subscribeToAttributes();
				var value = snapshot.val();

				if(value){
					var deserializedRecord = listener._serializer.deserialize(type, recordId, snapshot.val());
					listener._emitDidTransform(new Operation['default']({ op: 'add', path: path, value: deserializedRecord }) );
				} else {
					listener._emitDidTransform(new Operation['default']({ op: 'remove', path: path }));
				}

				options.currentIncludes().map(function(link){
					return listener.subscribeToLink(type, recordId, link, options.forLink(link));
				});

			});
		},

		subscribeToAttributes: function(){
			var _this = this;
			this.listener._enableListener(this.path, "child_changed", function(snapshot){
				if(_this._isAttribute(snapshot.key())){
					_this._updateAttribute(snapshot.key(), snapshot.val());
				}
			});
		},

		_updateAttribute: function(attribute, serialized){
			var model = this.type;
			var attrType = this.modelSchema.attributes[attribute].type;
			var transformation = transformations.lookupTransformation(attrType);
			var deserialized = transformation.deserialize(serialized);
			var attributePath = this.path + "/" + attribute;

			this.listener._emitDidTransform(new Operation['default']({ op: 'replace', path: attributePath, value: deserialized }));
		},

		_isAttribute: function(key){
			return Object.keys(this.modelSchema.attributes).indexOf(key) !== -1;
		},

		update: function(){
			var listener = this.listener;
			var options = this.options;
			var splitPath = this.path.split("/");
			var type = splitPath[0];
			var recordId = splitPath[1];

			options.currentIncludes().map(function(link){
				return listener.subscribeToLink(type, recordId, link, options.forLink(link));
			});

			return Orbit['default'].resolve();
		}
	});

});
define('orbit-firebase/subscriptions/subscription', ['exports', 'orbit/lib/objects', 'orbit/main'], function (exports, objects, Orbit) {

  'use strict';

  exports['default'] = objects.Class.extend({
    enqueue: function(func){
      this._queue = this._queue || Orbit['default'].resolve();
      this._queue = this._queue.then(func);
      return this._queue;
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
define('orbit-firebase/transformers/add-to-has-one', ['exports', 'orbit/main', 'orbit-common/main', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, Orbit, OC, objects, SchemaUtils, array_utils) {

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
define('orbit-firebase/transformers/replace-has-many', ['exports', 'orbit/main', 'orbit-common/main', 'orbit/lib/objects', 'orbit-firebase/lib/schema-utils', 'orbit-firebase/lib/array-utils'], function (exports, Orbit, OC, objects, SchemaUtils, array_utils) {

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
			this._cache.transform(operation);
			return Orbit['default'].resolve();
		}
	});

});

})();
//# sourceMappingURL=orbit-firebase.map