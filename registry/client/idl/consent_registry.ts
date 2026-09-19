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
        "Commit one film-event to the camera's rolling hash chain:",
        "`head = sha256(head || event_hash)`, `count += 1`.",
        "",
        "Only a 32-byte hash of the off-chain `FilmEvent` record lands on-chain",
        "(the record carries a random event id, so the hash is not guessable).",
        "Anyone holding the off-chain log can recompute the chain and prove the",
        "log is complete and unmodified; nobody can learn from the chain alone",
        "who was filmed."
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
          "name": "eventHash",
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
        "Remove a per-event override; rent returns to the owner."
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  118,
                  101,
                  114,
                  114,
                  105,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              },
              {
                "kind": "arg",
                "path": "eventId"
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
      "name": "register",
      "docs": [
        "Create the consent record for `badge_id`. `owner` becomes the only key",
        "that can change it; `payer` funds rent (may be the same key, or an",
        "organizer sponsoring badges that hold no SOL)."
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
            "The badge's key. Becomes the sole authority over this record."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Funds rent. Usually the owner; may be a sponsor."
          ],
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
        "`consent_message(badge_id, consent, nonce)`. We introspect that",
        "instruction via the Instructions sysvar and require that the verified",
        "pubkey is the record's owner and the verified message is exactly the",
        "one we expect. `nonce` must equal the record's current `revision`, so",
        "every signed message is single-use (compare-and-swap ⇒ no replay)."
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
        }
      ]
    },
    {
      "name": "setEventOverride",
      "docs": [
        "Set (or update) a per-event override for this badge."
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  118,
                  101,
                  114,
                  114,
                  105,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "consent.badgeId",
                "account": "consentAccount"
              },
              {
                "kind": "arg",
                "path": "eventId"
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
      "msg": "Only the record owner may do this"
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
      "name": "eventIdTooLong",
      "msg": "event_id must be 1..=32 bytes"
    },
    {
      "code": 6007,
      "name": "labelTooLong",
      "msg": "label must be <= 32 bytes"
    },
    {
      "code": 6008,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6009,
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
              "Rolling hash: `head_n = sha256(head_{n-1} || event_hash_n)`, `head_0 = 0`."
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
            "name": "eventHash",
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
              "Increments on every change; doubles as the nonce for delegated updates."
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
        "Per-event override. PDA seeds: `[\"override\", badge_id u16 LE, event_id]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "badgeId",
            "type": "u16"
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
    }
  ]
};
