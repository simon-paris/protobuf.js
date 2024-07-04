"use strict";
module.exports = decoder;

var Enum    = require("./enum"),
    types   = require("./types"),
    util    = require("./util");

var LEN_TYPE = 2;
var SGROUP_TYPE = 3;
var EGROUP_TYPE = 4;

function missing(field) {
    return "missing required '" + field.name + "'";
}

function tag(fieldId, wireType) {
    // Use math here, not bitwise ops, the output can be bigger than 32 bits
    return (fieldId * 8) + wireType;
}

/**
 * Generates a decoder specific to the specified message type.
 * @param {Type} mtype Message type
 * @returns {Codegen} Codegen instance
 */
function decoder(mtype) {
    /* eslint-disable no-unexpected-multiline */
    var gen = util.codegen(["r", "l"], mtype.name + "$decode")
    ("if(!(r instanceof Reader))")
        ("r=Reader.create(r)")

    ("var c=l===undefined?r.len:r.pos+l,") // Max offset
        ("c2=0,") // Inner max offset
        ("t=0,t2=0,") // Tag, inner tag
        ("k,v,") // Key, value temps for maps
        ("m=new this.ctor") // Message instance

    ("while(r.pos<c){")
        ("t=r.uint32()");

    if (mtype.group) {
        gen
        ("if((t&7)===%i)break", EGROUP_TYPE);
    }

    gen
        ("switch(t){");

    var i = 0;
    for (; i < /* initializes */ mtype.fieldsArray.length; ++i) {
        var field = mtype._fieldsArray[i].resolve(),
            type  = field.resolvedType instanceof Enum ? "int32" : field.type,
            group = field.resolvedType && field.resolvedType.group,
            basicWireType = types.basic[type],
            defaultValue = types.defaults[type],
            ref   = "m" + util.safeProp(field.name);

        if (field.map) {
            // Map fields
            var mapKeyType = field.keyType,
                mapKeyWireType = types.basic[mapKeyType],
                mapKeyLongWireType = types.long[mapKeyType],
                mapDefaultKey = types.defaults[mapKeyType];

            gen
            ("case %i: {", tag(field.id, LEN_TYPE))
                ("if(%s===util.emptyObject)", ref)
                    ("%s={}", ref) // Initialize empty map
                ("c2 = r.uint32()+r.pos")
                ("k=%j", mapDefaultKey === undefined ? null : mapDefaultKey) // Key if key is missing
                ("v=%j", defaultValue === undefined ? null : defaultValue) // Value if value is missing
                ("while(r.pos<c2){")
                    ("t2=r.uint32()")
                    ("switch(t2){")
                        ("case %i:", tag(1, mapKeyWireType))
                            ("k=r.%s()", mapKeyType)
                            ("break")
                        ("case %i:", tag(2, basicWireType === undefined ? LEN_TYPE : basicWireType));

            if (basicWireType === undefined) {
                gen
                            ("v=types[%i].decode(r,r.uint32())", i); // can't be groups
            } else {
                gen
                            ("v=r.%s()", type);
            }

            gen
                            ("break")
                        ("default:")
                            ("r.skipType(t2&7)")
                            ("break")
                    ("}") // end inner switch
                ("}") // end inner loop

            // Assign k/v pair to map. Use a hash if the key type is a long.
            if (mapKeyLongWireType === undefined) {
                gen
                ("%s[k]=v", ref)
            } else {
                gen
                ("%s[typeof k===\"object\"?util.longToHash(k):k]=v", ref)
            }

            gen
                ("break")
            ("}"); // end case

        } else if (field.repeated) {
            if (group) {
                // Repeated groups
                gen
                ("case %i: {", tag(field.id, SGROUP_TYPE))
                    ("if(!(%s&&%s.length))%s=[]", ref, ref, ref)
                    ("%s.push(types[%i].decode(r))", ref, i)
                    ("break")
                ("}");

            } else if (basicWireType === undefined) {
                // Repeated message fields
                gen
                ("case %i: {", tag(field.id, LEN_TYPE))
                    ("if(!(%s&&%s.length))%s=[]", ref, ref, ref)
                    ("%s.push(types[%i].decode(r,r.uint32()))", ref, i)
                    ("break")
                ("}");

            } else {
                // Repeated primative fields
                gen
                ("case %i: {", tag(field.id, basicWireType))
                    ("if(!(%s&&%s.length))%s=[]", ref, ref, ref)
                    ("%s.push(r.%s())", ref, type)
                    ("break")
                ("}");
            }

            if (types.packed[type] !== undefined) {
                // Packed fields
                gen
                ("case %i: {", tag(field.id, LEN_TYPE))
                    ("if(!(%s&&%s.length))%s=[]", ref, ref, ref)
                    ("c2=r.uint32()+r.pos")
                    ("while(r.pos<c2)")
                        ("%s.push(r.%s())", ref, type)
                    ("break")
                ("}");
            }

        } else {
            if (group) {
                // Groups
                gen
                ("case %i: {", tag(field.id, SGROUP_TYPE))
                    ("%s=types[%i].decode(r)", ref, i)
                    ("break")
                ("}");

            } else if (types.basic[type] === undefined) {
                // Message fields
                gen
                ("case %i: {", tag(field.id, group ? SGROUP_TYPE : LEN_TYPE))
                    (group ?
                        "%s=types[%i].decode(r)" :
                        "%s=types[%i].decode(r,r.uint32())", ref, i)
                    ("break")
                ("}");

            } else {
                // Primative fields
                gen
                ("case %i: {", tag(field.id, basicWireType))
                    ("%s=r.%s()", ref, type)
                    ("break")
                ("}");
            }
        }
    }

    // Unknown fields
    gen
                ("default:")
                    ("r.skipType(t&7)")
        ("}") // end switch statement
    ("}"); //  end loop

    // Field presence
    for (i = 0; i < mtype._fieldsArray.length; ++i) {
        var rfield = mtype._fieldsArray[i];
        if (rfield.required) gen
    ("if(!m.hasOwnProperty(%j))", rfield.name)
        ("throw util.ProtocolError(%j,{instance:m})", missing(rfield));
    }

    return gen
    ("return m");
    /* eslint-enable no-unexpected-multiline */
}
