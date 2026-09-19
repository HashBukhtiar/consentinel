/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/consent_registry.json`.
 */
export type ConsentRegistry = {
  "address": "UKoViTT9288nMeBzjeMoHBBmxHfXvbg6F1gF6pjiSW7",
  "metadata": {
    "name": "consentRegistry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Consentinel: user-owned, revocable likeness-consent records (one PDA per HTN badge)"
  },
  "instructions": [
    {
      "name": "attestCapture",
      "docs": [
        "Fold one commitment into the camera's rolling hash chain:",
        "`head = sha256(head || commitment)`, `count += 1`.",
        "",
        "The notify service submits one commitment per fixed interval: the hash",
        "of that interval's film-event hashes, or a zero commitment when nothing",
        "happened (\"heartbeat\"). So the chain carries a steady stream that",
        "proves the off-chain log is complete and unmodified, while revealing",
        "neither who was filmed nor *when* anyone was filmed. Film-event",
        "records themselves (with a random event id) never leave the operator."
      ],
      "discriminator": [
        73,
        93,
        66,
        9,
        136,
        139,
        67,
        121
      ],
      "accounts": [
        {
          "name": "camera",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  109,
                  101,
                  114,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "camera"
          ]
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "clearEventOverride",
      "docs": [
        "Remove a per-event override; rent returns to its owner. Works even",
        "after the consent record was closed (no orphaned rent)."
      ],
      "discriminator": [
        232,
        116,
        115,
        210,
        210,
        104,
        251,
        128
      ],
      "accounts": [
        {
          "name": "eventOverride",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "eventOverride"
          ]
        }
      ],
      "args": [
        {
          "name": "eventId",
          "type": "string"
        }
      ]
    },
    {
      "name": "closeConsent",
      "docs": [
        "Delete the record. Rent returns to the owner. With no record the",
        "capture app's fail-safe treats the badge as \"unknown\" ⇒ blur."
      ],
      "discriminator": [
        58,
        27,
        170,
        62,
        185,
        59,
        127,
        203
      ],
      "accounts": [
        {
          "name": "consent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "consent"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup: whoever pays becomes nothing; `issuer` is the organizer",
        "key allowed to bind badge ids to owner keys."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issuer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "register",
      "docs": [
        "Issuer creates the consent record for `badge_id` and binds it to the",
        "badge's key (`owner`). The issuer pays rent. From here on only `owner`",
        "can change or delete the record."
      ],
      "discriminator": [
        211,
        124,
        67,
        15,
        211,
        194,
        178,
        240
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "consent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "badgeId"
              }
            ]
          }
        },
        {
          "name": "owner",
          "docs": [
            "The issuer vouches for the binding (it provisions the badge), so no",
            "signature from the badge is needed at issuance."
          ]
        },
        {
          "name": "issuer",
          "docs": [
            "The organizer. Authorizes issuance and pays rent."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "registry"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "badgeId",
          "type": "u16"
        },
        {
          "name": "consent",
          "type": "bool"
        }
      ]
    },
    {
      "name": "registerCamera",
      "docs": [
        "A capture pipeline (camera) registers its tamper-evidence log."
      ],
      "discriminator": [
        169,
        161,
        144,
        207,
        102,
        130,
        86,
        62
      ],
      "accounts": [
        {
          "name": "camera",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  109,
                  101,
                  114,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "label",
          "type": "string"
        }
      ]
    },
    {
      "name": "setConsent",
      "docs": [
        "Owner-signed grant (`true`) or revoke (`false`)."
      ],
      "discriminator": [
        14,
        133,
        0,
        23,
        25,
        119,
        120,
        4
      ],
      "accounts": [
        {
          "name": "consent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "consent"
          ]
        }
      ],
      "args": [
        {
          "name": "consent",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setConsentDelegated",
      "docs": [
        "Badge-signed grant/revoke, relayed by anyone.",
        "",
        "The transaction must contain, immediately before this instruction, an",
        "Ed25519 native-program instruction verifying the owner's signature over",
        "`consent_message(badge_id, consent, nonce, instance, expires_at)`. We",
        "introspect that instruction via the Instructions sysvar and require",
        "that the verified pubkey is the record's owner and the verified message",
        "is exactly the one we expect. Single-use and unforgeable by a relayer:",
        "- `nonce` must equal the record's current `revision` (compare-and-swap);",
        "- `instance` must equal the record's `instance`, so a signature made",
        "for a previous registration of the same badge id can never replay;",
        "- `expires_at` bounds how long a relayer can sit on a signed message."
      ],
      "discriminator": [
        146,
        20,
        72,
        150,
        215,
        141,
        64,
        197
      ],
      "accounts": [
        {
          "name": "consent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              }
            ]
          }
        },
        {
          "name": "relayer",
          "docs": [
            "Pays the fee. Any key — authority comes from the badge's signature."
          ],
          "signer": true
        },
        {
          "name": "instructions",
          "docs": [
            "`load_instruction_at_checked`."
          ]
        }
      ],
      "args": [
        {
          "name": "consent",
          "type": "bool"
        },
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setEventOverride",
      "docs": [
        "Set (or update) a per-event override for this badge. The current badge",
        "owner takes ownership of the override (also when overwriting a stale",
        "one left by a previous owner)."
      ],
      "discriminator": [
        231,
        23,
        243,
        186,
        113,
        54,
        131,
        184
      ],
      "accounts": [
        {
          "name": "consent",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              }
            ]
          }
        },
        {
          "name": "eventOverride",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "consent"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "eventId",
          "type": "string"
        },
        {
          "name": "consent",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setIssuer",
      "discriminator": [
        122,
        240,
        209,
        127,
        179,
        164,
        175,
        206
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "issuer",
          "signer": true,
          "relations": [
            "registry"
          ]
        }
      ],
      "args": [
        {
          "name": "newIssuer",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "cameraLog",
      "discriminator": [
        178,
        105,
        10,
        243,
        225,
        5,
        193,
        237
      ]
    },
    {
      "name": "consentAccount",
      "discriminator": [
        129,
        26,
        32,
        122,
        68,
        134,
        146,
        154
      ]
    },
    {
      "name": "eventOverride",
      "discriminator": [
        142,
        13,
        217,
        153,
        231,
        50,
        117,
        61
      ]
    },
    {
      "name": "registry",
      "discriminator": [
        47,
        174,
        110,
        246,
        184,
        182,
        252,
        218
      ]
    }
  ],
  "events": [
    {
      "name": "captureAttested",
      "discriminator": [
        156,
        102,
        72,
        70,
        206,
        209,
        5,
        220
      ]
    },
    {
      "name": "consentChanged",
      "discriminator": [
        61,
        26,
        92,
        145,
        140,
        173,
        149,
        238
      ]
    },
    {
      "name": "consentClosed",
      "discriminator": [
        56,
        118,
        129,
        204,
        168,
        212,
        207,
        157
      ]
    },
    {
      "name": "eventOverrideChanged",
      "discriminator": [
        35,
        242,
        65,
        194,
        91,
        191,
        53,
        246
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Only the record owner (or the issuer, for issuance) may do this"
    },
    {
      "code": 6001,
      "name": "nonceMismatch",
      "msg": "Nonce must equal the record's current revision"
    },
    {
      "code": 6002,
      "name": "missingSignatureInstruction",
      "msg": "Expected an Ed25519 native-program instruction immediately before this one"
    },
    {
      "code": 6003,
      "name": "badSignatureInstruction",
      "msg": "Ed25519 instruction has an unexpected layout"
    },
    {
      "code": 6004,
      "name": "signatureNotFromOwner",
      "msg": "Signature was not made by the record owner"
    },
    {
      "code": 6005,
      "name": "messageMismatch",
      "msg": "Signed message does not match this consent update"
    },
    {
      "code": 6006,
      "name": "signatureExpired",
      "msg": "Signed message has expired"
    },
    {
      "code": 6007,
      "name": "signatureTtlTooLong",
      "msg": "Signed message validity exceeds the maximum TTL"
    },
    {
      "code": 6008,
      "name": "eventIdTooLong",
      "msg": "event_id must be 1..=32 bytes"
    },
    {
      "code": 6009,
      "name": "labelTooLong",
      "msg": "label must be <= 32 bytes"
    },
    {
      "code": 6010,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6011,
      "name": "badSysvar",
      "msg": "Expected the Instructions sysvar"
    }
  ],
  "types": [
    {
      "name": "cameraLog",
      "docs": [
        "A capture pipeline's tamper-evidence log. PDA seeds: `[\"camera\", authority]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "label",
            "type": "string"
          },
          {
            "name": "head",
            "docs": [
              "Rolling hash: `head_n = sha256(head_{n-1} || commitment_n)`, `head_0 = 0`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "count",
            "type": "u64"
          },
          {
            "name": "firstAt",
            "type": "i64"
          },
          {
            "name": "lastAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "captureAttested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "camera",
            "type": "pubkey"
          },
          {
            "name": "count",
            "type": "u64"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "head",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "consentAccount",
      "docs": [
        "One per badge. PDA seeds: `[\"consent\", badge_id u16 LE]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "docs": [
              "The short id the badge blinks (8–16 bits)."
            ],
            "type": "u16"
          },
          {
            "name": "owner",
            "docs": [
              "The only key allowed to change or delete this record."
            ],
            "type": "pubkey"
          },
          {
            "name": "consent",
            "docs": [
              "`true` = opted in to being recorded. Absent record or `false` ⇒ blur."
            ],
            "type": "bool"
          },
          {
            "name": "revision",
            "docs": [
              "Increments on every change; the nonce for delegated updates."
            ],
            "type": "u64"
          },
          {
            "name": "instance",
            "docs": [
              "Unique per registration; binds delegated signatures to this record."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "consentChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "type": "u16"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "consent",
            "type": "bool"
          },
          {
            "name": "revision",
            "type": "u64"
          },
          {
            "name": "instance",
            "type": "u64"
          },
          {
            "name": "at",
            "type": "i64"
          },
          {
            "name": "delegated",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "consentClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "type": "u16"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "eventOverride",
      "docs": [
        "Per-event override. PDA seeds: `[\"override\", badge_id u16 LE, sha256(event_id)]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "type": "u16"
          },
          {
            "name": "owner",
            "docs": [
              "The badge owner who set it; may clear it even after `close_consent`."
            ],
            "type": "pubkey"
          },
          {
            "name": "eventId",
            "type": "string"
          },
          {
            "name": "consent",
            "type": "bool"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "eventOverrideChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "type": "u16"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "eventId",
            "type": "string"
          },
          {
            "name": "consent",
            "docs": [
              "`None` ⇒ override cleared."
            ],
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "registry",
      "docs": [
        "Singleton. PDA seeds: `[\"registry\"]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuer",
            "docs": [
              "The organizer key allowed to bind badge ids to owner keys."
            ],
            "type": "pubkey"
          },
          {
            "name": "registrations",
            "docs": [
              "Monotonic; gives every registration a unique `instance`."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
