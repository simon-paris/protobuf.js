"use strict";
module.exports = Root;

// extends Namespace
var Namespace = require("./namespace");
((Root.prototype = Object.create(Namespace.prototype)).constructor = Root).className = "Root";

var Field   = require("./field"),
    Enum    = require("./enum"),
    OneOf   = require("./oneof"),
    util    = require("./util");

var Type,   // cyclic
    parse,  // might be excluded
    common; // "

/**
 * Constructs a new root namespace instance.
 * @classdesc Root namespace wrapping all types, enums, services, sub-namespaces etc. that belong together.
 * @extends NamespaceBase
 * @constructor
 * @param {Object.<string,*>} [options] Top level options
 */
function Root(options) {
    Namespace.call(this, "", options);

    /**
     * Deferred extension fields.
     * @type {Field[]}
     */
    this.deferred = [];

    /**
     * Resolved file names of loaded files.
     * @type {string[]}
     */
    this.files = [];
}

/**
 * Loads a namespace descriptor into a root namespace.
 * @param {INamespace} json Nameespace descriptor
 * @param {Root} [root] Root namespace, defaults to create a new one if omitted
 * @returns {Root} Root namespace
 */
Root.fromJSON = function fromJSON(json, root) {
    if (!root)
        root = new Root();
    if (json.options)
        root.setOptions(json.options);
    return root.addJSON(json.nested);
};

/**
 * Resolves the path of an imported file, relative to the importing origin.
 * This method exists so you can override it with your own logic in case your imports are scattered over multiple directories.
 * @function
 * @param {string} origin The file name of the importing file
 * @param {string} target The file name being imported
 * @returns {string|null} Resolved path to `target` or `null` to skip the file
 */
Root.prototype.resolvePath = util.path.resolve;

/**
 * Fetch content from file path or url
 * This method exists so you can override it with your own logic.
 * @function
 * @param {string} path File path or url
 * @param {FetchCallback} callback Callback function
 * @returns {undefined}
 */
Root.prototype.fetch = util.fetch;

// If a bundled file exists, return its canonical name
function getBundledFileName(filename) {
    var idx = filename.lastIndexOf("google/protobuf/");
    if (idx > -1) {
        var altname = filename.substring(idx);
        if (altname in common) return altname;
    }
    return null;
}

// Fetch a bundled definition
function getBundled(filename) {
    filename = getBundledFileName(filename) || filename;
    if (filename in common) {
        return common[filename];
    }
    return undefined;
}

// Processes a single file synchronously, returning the next set of files to load
function processSingleFile(self, filename, source, options) {
    if (util.isString(source) && source.charAt(0) === "{")
        source = JSON.parse(source);
    if (!util.isString(source)) {
        self.setOptions(source.options).addJSON(source.nested);
        return [];
    }

    parse.filename = filename;
    var parsed = parse(source, self, options),
        nextResolvedImports = [],
        nextResolvedFilename,
        i;
    if (parsed.imports) {
        for (i = 0; i < parsed.imports.length; i++) {
            nextResolvedFilename = getBundledFileName(parsed.imports[i]) || self.resolvePath(filename, parsed.imports[i]);
            if (nextResolvedFilename !== null)
                nextResolvedImports.push({ filename: nextResolvedFilename, weak: false });
        }
    }
    if (parsed.weakImports) {
        for (i = 0; i < parsed.weakImports.length; i++) {
            nextResolvedFilename = getBundledFileName(parsed.weakImports[i]) || self.resolvePath(filename, parsed.weakImports[i]);
            if (nextResolvedFilename !== null)
                nextResolvedImports.push({ filename: nextResolvedFilename, weak: true });
        }
    }
    return nextResolvedImports;
}

function fetchSingleFileSync(self, filename) {
    // Skip if already loaded / attempted
    if (self.files.indexOf(filename) > -1)
        return undefined;
    self.files.push(filename);

    // Load bundled package
    var bundled = getBundled(filename);
    if (bundled) return bundled;

    // Load from disk
    return util.fs.readFileSync(filename).toString("utf8");
}

function fetchSingleFileAsync(self, filename, cb) {
    // Skip if already loaded / attempted
    if (self.files.indexOf(filename) > -1) {
        setTimeout(cb, 0, null, undefined);
        return;
    }
    self.files.push(filename);

    // Load bundled package
    var bundled = getBundled(filename);
    if (bundled) {
        setTimeout(cb, 0, null, bundled);
        return;
    }

    // Load from disk or network
    self.fetch(filename, function (err, source) {
        cb(err, source);
    });
}

// A symbol that means no action is required to import a file.
// Either the file was already imported, or it's a weak import that failed.
var IMPORT_NOOP = { IMPORT_NOOP: true };
// A symbol that means an import is currently being fetched
var IMPORT_IN_FLIGHT = { IMPORT_IN_FLIGHT: true };

/**
 * Loads one or multiple .proto or preprocessed .json files into this root namespace and calls the callback.
 * @param {string|string[]} filename Names of one or multiple files to load
 * @param {IParseOptions} options Parse options
 * @param {LoadCallback} callback Callback function
 * @returns {undefined}
 */
Root.prototype.load = function load(filename, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }
    var self = this;
    if (!callback)
        return util.asPromise(load, self, filename, options);

    // Stack of work. The stack can contain:
    // - objects containing { filename: string, source: string } (protobuf source, will be parsed)
    // - the IMPORT_IN_FLIGHT symbol (means we need to stop and wait)
    // - the IMPORT_NOOP symbol (file was already imported, or an error occurred but it can be ignored)
    // - error objects (will be passed to the callback when it reaches the top of the stack)
    var stack = [];

    // Ensure the callback is only called once
    var callbackCalled = false;
    function finish(err) {
        if (callbackCalled) return;
        callbackCalled = true;
        callback(err, err ? null : self);
    }

    // Reserve a slot in the stack, and asynchronously populate it. Then call doParseWork to drain available work.
    function fetchOneFile(resolvedFilename, weak) {
        var slot = stack.length;
        stack.push(IMPORT_IN_FLIGHT);

        // Load file
        fetchSingleFileAsync(self, resolvedFilename, (err, source) => {
            if (err) {
                // Failed to import
                stack[slot] = weak ? IMPORT_NOOP : err;
            } else if (source === undefined) {
                // File already imported
                stack[slot] = IMPORT_NOOP;
            } else {
                stack[slot] = { filename: resolvedFilename, source };
            }
            doParseWork();
        });
    }

    // Parse sources at the top of the stack until the stack is empty or until we need to stop and wait for an async fetch.
    function doParseWork() {
        if (callbackCalled) return; // Avoid parsing anything new after the callback was called.

        while (stack.length) {
            var stackTop = stack.pop();
            if (stackTop === IMPORT_IN_FLIGHT) {
                stack.push(stackTop); // Not ready, put it back on stack
                return;
            }
            if (stackTop === IMPORT_NOOP)
                continue; // Import is ok, but nothing to do
            if (stackTop instanceof Error) {
                finish(stackTop); // Import is an error
                return;
            }

            var nextResolvedImports;
            try {
                nextResolvedImports = processSingleFile(self, stackTop.filename, stackTop.source, options);
            } catch (err) {
                // Stop immediently if something fails to parse
                finish(err);
                return;
            }

            // Dispatch import requests (backwards)
            var j = nextResolvedImports.length;
            while (j--) {
                var importItem = nextResolvedImports[j];
                fetchOneFile(importItem.filename, importItem.weak);
            }
        }

        // We're done if we emptied the stack
        finish(null);
    }


    // Resolve and fetch initial files (backwards)
    filename = util.isString(filename) ? [filename] : filename;
    var i = filename.length;
    while (i--) {
        const resolvedFilename = getBundledFileName(filename[i]) || self.resolvePath("", filename[i]);
        if (resolvedFilename !== null)
            fetchOneFile(resolvedFilename, false);
    }

    // Special case for empty list
    if (stack.length === 0)
        finish(null);

    return undefined;
};
// function load(filename:string, options:IParseOptions, callback:LoadCallback):undefined

/**
 * Loads one or multiple .proto or preprocessed .json files into this root namespace and calls the callback.
 * @function Root#load
 * @param {string|string[]} filename Names of one or multiple files to load
 * @param {LoadCallback} callback Callback function
 * @returns {undefined}
 * @variation 2
 */
// function load(filename:string, callback:LoadCallback):undefined

/**
 * Loads one or multiple .proto or preprocessed .json files into this root namespace and returns a promise.
 * @function Root#load
 * @param {string|string[]} filename Names of one or multiple files to load
 * @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
 * @returns {Promise<Root>} Promise
 * @variation 3
 */
// function load(filename:string, [options:IParseOptions]):Promise<Root>

/**
 * Synchronously loads one or multiple .proto or preprocessed .json files into this root namespace (node only).
 * @function Root#loadSync
 * @param {string|string[]} filename Names of one or multiple files to load
 * @param {IParseOptions} [options] Parse options. Defaults to {@link parse.defaults} when omitted.
 * @returns {Root} Root namespace
 * @throws {Error} If synchronous fetching is not supported (i.e. in browsers) or if a file's syntax is invalid
 */
Root.prototype.loadSync = function loadSync(filename, options) {
    if (!util.isNode)
        throw Error("not supported");

    var self = this;

    // Stack of work containing { filename: string, weak: boolean }
    var stack = [];

    // Resolve initial files and append to stack (backwards)
    filename = util.isString(filename) ? [filename] : filename;
    var i = filename.length;
    while (i--) {
        const resolvedFilename = getBundledFileName(filename[i]) || self.resolvePath("", filename[i]);
        if (resolvedFilename !== null)
            stack.push({ filename: resolvedFilename, weak: false });
    }

    while (stack.length) {
        var stackTop = stack.pop();

        // Load file
        var source;
        try {
            source = fetchSingleFileSync(self, stackTop.filename);
        } catch (err) {
            if (stackTop.weak) continue;
            else throw err;
        }
        var nextResolvedImports = processSingleFile(self, stackTop.filename, source, options);

        // Append imports to stack (backwards)
        var j = nextResolvedImports.length;
        while (j--)
            stack.push(nextResolvedImports[j]);
    }

    return self;
};

/**
 * @override
 */
Root.prototype.resolveAll = function resolveAll() {
    if (this.deferred.length)
        throw Error("unresolvable extensions: " + this.deferred.map(function(field) {
            return "'extend " + field.extend + "' in " + field.parent.fullName;
        }).join(", "));
    return Namespace.prototype.resolveAll.call(this);
};

// only uppercased (and thus conflict-free) children are exposed, see below
var exposeRe = /^[A-Z]/;

/**
 * Handles a deferred declaring extension field by creating a sister field to represent it within its extended type.
 * @param {Root} root Root instance
 * @param {Field} field Declaring extension field witin the declaring type
 * @returns {boolean} `true` if successfully added to the extended type, `false` otherwise
 * @inner
 * @ignore
 */
function tryHandleExtension(root, field) {
    var extendedType = field.parent.lookup(field.extend);
    if (extendedType) {
        var sisterField = new Field(field.fullName, field.id, field.type, field.rule, undefined, field.options);
        //do not allow to extend same field twice to prevent the error
        if (extendedType.get(sisterField.name)) {
            return true;
        }
        sisterField.declaringField = field;
        field.extensionField = sisterField;
        extendedType.add(sisterField);
        return true;
    }
    return false;
}

/**
 * Called when any object is added to this root or its sub-namespaces.
 * @param {ReflectionObject} object Object added
 * @returns {undefined}
 * @private
 */
Root.prototype._handleAdd = function _handleAdd(object) {
    if (object instanceof Field) {

        if (/* an extension field (implies not part of a oneof) */ object.extend !== undefined && /* not already handled */ !object.extensionField)
            if (!tryHandleExtension(this, object))
                this.deferred.push(object);

    } else if (object instanceof Enum) {

        if (exposeRe.test(object.name))
            object.parent[object.name] = object.values; // expose enum values as property of its parent

    } else if (!(object instanceof OneOf)) /* everything else is a namespace */ {

        if (object instanceof Type) // Try to handle any deferred extensions
            for (var i = 0; i < this.deferred.length;)
                if (tryHandleExtension(this, this.deferred[i]))
                    this.deferred.splice(i, 1);
                else
                    ++i;
        for (var j = 0; j < /* initializes */ object.nestedArray.length; ++j) // recurse into the namespace
            this._handleAdd(object._nestedArray[j]);
        if (exposeRe.test(object.name))
            object.parent[object.name] = object; // expose namespace as property of its parent
    }

    // The above also adds uppercased (and thus conflict-free) nested types, services and enums as
    // properties of namespaces just like static code does. This allows using a .d.ts generated for
    // a static module with reflection-based solutions where the condition is met.
};

/**
 * Called when any object is removed from this root or its sub-namespaces.
 * @param {ReflectionObject} object Object removed
 * @returns {undefined}
 * @private
 */
Root.prototype._handleRemove = function _handleRemove(object) {
    if (object instanceof Field) {

        if (/* an extension field */ object.extend !== undefined) {
            if (/* already handled */ object.extensionField) { // remove its sister field
                object.extensionField.parent.remove(object.extensionField);
                object.extensionField = null;
            } else { // cancel the extension
                var index = this.deferred.indexOf(object);
                /* istanbul ignore else */
                if (index > -1)
                    this.deferred.splice(index, 1);
            }
        }

    } else if (object instanceof Enum) {

        if (exposeRe.test(object.name))
            delete object.parent[object.name]; // unexpose enum values

    } else if (object instanceof Namespace) {

        for (var i = 0; i < /* initializes */ object.nestedArray.length; ++i) // recurse into the namespace
            this._handleRemove(object._nestedArray[i]);

        if (exposeRe.test(object.name))
            delete object.parent[object.name]; // unexpose namespaces

    }
};

// Sets up cyclic dependencies (called in index-light)
Root._configure = function(Type_, parse_, common_) {
    Type   = Type_;
    parse  = parse_;
    common = common_;
};
