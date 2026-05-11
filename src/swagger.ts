/**
 * OpenAPI/Swagger specification for Palmyr
 */
export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Palmyr API',
    description: 'Autonomous infrastructure for AI agents — pay with USDC on Solana via x402',
    version: '0.1.0',
    contact: {
      name: 'Palmyr',
      email: 'zolty@openclaw.ai',
      url: 'https://github.com/0xArtex/Palmyr'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server'
    }
  ],
  paths: {
    '/api': {
      get: {
        summary: 'Get API information',
        description: 'Returns basic information about the Palmyr API',
        responses: {
          '200': {
            description: 'API information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string', example: 'Palmyr' },
                    version: { type: 'string', example: '0.1.0' },
                    status: { type: 'string', example: 'operational' },
                    docs: { type: 'string', example: 'https://github.com/0xArtex/Palmyr' },
                    services: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['phone', 'email', 'domains', 'compute', 'apikeys']
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/health': {
      get: {
        summary: 'Health check',
        description: 'Check if the service is running',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    uptime: { type: 'number', example: 3600 }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/pricing': {
      get: {
        summary: 'Get pricing information',
        description: 'Returns pricing for all services in USDC',
        responses: {
          '200': {
            description: 'Pricing information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    currency: { type: 'string', example: 'USDC' },
                    network: { type: 'string', example: 'solana' },
                    services: {
                      type: 'object',
                      properties: {
                        phone: {
                          type: 'object',
                          properties: {
                            provision_number: { type: 'string', example: '2.00' },
                            get_messages: { type: 'string', example: '0.01' },
                            send_sms: { type: 'string', example: '0.05' }
                          }
                        },
                        email: {
                          type: 'object',
                          properties: {
                            create_inbox: { type: 'string', example: '1.00' },
                            get_messages: { type: 'string', example: '0.01' },
                            send_email: { type: 'string', example: '0.05' }
                          }
                        },
                        domains: {
                          type: 'object',
                          properties: {
                            register_domain: { type: 'string', example: '10.00' },
                            get_status: { type: 'string', example: '0.01' },
                            update_dns: { type: 'string', example: '0.10' }
                          }
                        },
                        compute: {
                          type: 'object',
                          properties: {
                            create_server: { type: 'string', example: '5.00' },
                            list_servers: { type: 'string', example: '0.01' },
                            get_server: { type: 'string', example: '0.01' },
                            delete_server: { type: 'string', example: '0.10' },
                            upload_ssh_key: { type: 'string', example: '0.10' }
                          }
                        },
                        apikeys: {
                          type: 'object',
                          properties: {
                            provision_key: { type: 'string', example: '1.00' },
                            list_keys: { type: 'string', example: '0.01' },
                            revoke_key: { type: 'string', example: '0.01' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/phone/provision': {
      post: {
        summary: 'Provision a phone number',
        description: 'Provision a new phone number for SMS services',
        security: [{ x402: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  country: { type: 'string', example: 'US' },
                  areaCode: { type: 'string', example: '555' }
                },
                required: ['country']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Phone number provisioned successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    phoneNumber: { type: 'string' },
                    country: { type: 'string' },
                    owner: { type: 'string' },
                    provisionedAt: { type: 'string' },
                    active: { type: 'boolean' }
                  }
                }
              }
            }
          },
          '402': { $ref: '#/components/responses/PaymentRequired' }
        }
      }
    },
    '/email/create-inbox': {
      post: {
        summary: 'Create email inbox',
        description: 'Create a new email inbox with custom name',
        security: [{ x402: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'my-agent' }
                },
                required: ['name']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Email inbox created successfully'
          },
          '402': { $ref: '#/components/responses/PaymentRequired' }
        }
      }
    },
    '/domains/register': {
      post: {
        summary: 'Register a domain',
        description: 'Register a new domain name',
        security: [{ x402: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'myagent' },
                  tld: { type: 'string', example: 'com' }
                },
                required: ['name', 'tld']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Domain registration initiated'
          },
          '402': { $ref: '#/components/responses/PaymentRequired' }
        }
      }
    },
    '/compute/create': {
      post: {
        summary: 'Create a server',
        description: 'Create a new cloud server instance',
        security: [{ x402: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'my-server' },
                  serverType: { 
                    type: 'string', 
                    enum: ['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cpx51'],
                    example: 'cax11'
                  },
                  image: { type: 'string', example: 'ubuntu-22.04' }
                },
                required: ['name', 'serverType', 'image']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Server creation initiated'
          },
          '402': { $ref: '#/components/responses/PaymentRequired' }
        }
      }
    },
    '/apikeys/provision': {
      post: {
        summary: 'Provision API key',
        description: 'Provision a new API key for external services',
        security: [{ x402: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  provider: { 
                    type: 'string',
                    enum: ['brave_search', 'helius', 'openai', 'anthropic', 'elevenlabs', 'custom'],
                    example: 'openai'
                  },
                  label: { type: 'string', example: 'My OpenAI Key' }
                },
                required: ['provider', 'label']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'API key provisioned successfully'
          },
          '402': { $ref: '#/components/responses/PaymentRequired' }
        }
      }
    },
    '/demo/provision-phone': {
      get: {
        summary: 'Demo: Phone number provisioning',
        description: 'Simulate phone number provisioning without payment (returns mock data)',
        tags: ['Demo'],
        responses: {
          '200': {
            description: 'Mock phone number data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'demo_abc123' },
                    number: { type: 'string', example: '+12125551234' },
                    friendlyName: { type: 'string', example: '(212) 555-1234' },
                    country: { type: 'string', example: 'US' },
                    cost: { type: 'string', example: '2.00 USDC' },
                    demo: { type: 'boolean', example: true },
                    note: { type: 'string', example: 'This is demo data. Real endpoint: POST /phone/numbers' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/demo/create-inbox': {
      get: {
        summary: 'Demo: Email inbox creation',
        description: 'Simulate email inbox creation without payment (returns mock data)',
        tags: ['Demo'],
        responses: {
          '200': {
            description: 'Mock email inbox data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'demo_inbox_abc123' },
                    email: { type: 'string', example: 'agent-abc123@palmyr.dev' },
                    password: { type: 'string', example: '[generated-password]' },
                    cost: { type: 'string', example: '1.00 USDC' },
                    demo: { type: 'boolean', example: true },
                    note: { type: 'string', example: 'This is demo data. Real endpoint: POST /email/inboxes' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/demo/create-server': {
      get: {
        summary: 'Demo: Server creation',
        description: 'Simulate server creation without payment (returns mock data)',
        tags: ['Demo'],
        responses: {
          '200': {
            description: 'Mock server data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'demo_server_abc123' },
                    name: { type: 'string', example: 'agent-server-abc123' },
                    type: { type: 'string', example: 'cx11' },
                    ipv4: { type: 'string', example: '192.0.2.123' },
                    cost: { type: 'string', example: '5.00 USDC' },
                    demo: { type: 'boolean', example: true },
                    note: { type: 'string', example: 'This is demo data. Real endpoint: POST /compute/servers' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/demo/provision-apikey': {
      get: {
        summary: 'Demo: API key provisioning',
        description: 'Simulate API key provisioning without payment (returns mock data)',
        tags: ['Demo'],
        responses: {
          '200': {
            description: 'Mock API key data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'demo_key_abc123' },
                    provider: { type: 'string', example: 'openai' },
                    keyPreview: { type: 'string', example: 'sk-proj-abc123...xyz789' },
                    cost: { type: 'string', example: '1.00 USDC' },
                    demo: { type: 'boolean', example: true },
                    note: { type: 'string', example: 'This is demo data. Real endpoint: POST /apikeys' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/phone/webhooks/telnyx': {
      post: {
        summary: 'Telnyx SMS webhook',
        description: 'Handle inbound SMS messages from Telnyx (webhook callback)',
        tags: ['Webhooks'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  MessageSid: { type: 'string', example: 'SM1234567890abcdef' },
                  From: { type: 'string', example: '+15551234567' },
                  To: { type: 'string', example: '+12125551234' },
                  Body: { type: 'string', example: 'Hello from SMS!' },
                  NumMedia: { type: 'string', example: '0' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'SMS webhook processed successfully',
            content: {
              'application/xml': {
                schema: {
                  type: 'string',
                  example: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Message received by Palmyr</Message></Response>'
                }
              }
            }
          },
          '401': {
            description: 'Invalid webhook signature'
          }
        }
      }
    },
    '/webhooks/sendgrid/inbound': {
      post: {
        summary: 'SendGrid inbound email webhook',
        description: 'Handle inbound emails from SendGrid Inbound Parse (webhook callback)',
        tags: ['Webhooks'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  from: { type: 'string', example: 'sender@example.com' },
                  to: { type: 'string', example: 'agent-123@palmyr.dev' },
                  subject: { type: 'string', example: 'Hello Palmyr' },
                  text: { type: 'string', example: 'Email body text' },
                  html: { type: 'string', example: '<p>Email body HTML</p>' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Email webhook processed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'received' }
                  }
                }
              }
            }
          },
          '401': {
            description: 'Invalid webhook signature'
          }
        }
      }
    },
    '/webhooks/test': {
      get: {
        summary: 'Webhook test endpoint',
        description: 'Simple endpoint for testing webhook infrastructure',
        tags: ['Webhooks'],
        security: [],
        responses: {
          '200': {
            description: 'Webhook test response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    message: { type: 'string', example: 'Webhook endpoint is working' },
                    timestamp: { type: 'string', example: '2024-02-09T01:30:00.000Z' }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      x402: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Payment',
        description: 'Solana USDC transaction signature for x402 payment verification'
      }
    },
    responses: {
      PaymentRequired: {
        description: 'Payment required via x402 protocol',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string', example: 'Payment Required' },
                message: { type: 'string', example: 'Include a Solana USDC transaction signature in the X-Payment header' },
                protocol: { type: 'string', example: 'x402' },
                treasury: { type: 'string', example: 'YOUR_SOLANA_WALLET_ADDRESS' },
                currency: { type: 'string', example: 'USDC' },
                network: { type: 'string', example: 'solana' }
              }
            }
          }
        }
      }
    },
    schemas: {
      PaymentProof: {
        type: 'object',
        properties: {
          signature: { type: 'string', description: 'Solana transaction signature' },
          payer: { type: 'string', description: 'Payer wallet address' },
          amountLamports: { type: 'string', description: 'Amount in USDC (6 decimals)' },
          verifiedAt: { type: 'number', description: 'Unix timestamp of verification' }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' }
        }
      }
    }
  },
  tags: [
    {
      name: 'Phone',
      description: 'SMS and phone number services'
    },
    {
      name: 'Email',
      description: 'Email inbox and messaging services'
    },
    {
      name: 'Domains',
      description: 'Domain registration and DNS management'
    },
    {
      name: 'Compute',
      description: 'Cloud server provisioning and management'
    },
    {
      name: 'API Keys',
      description: 'Third-party API key provisioning'
    },
    {
      name: 'Demo',
      description: 'Demo endpoints (no payment required, returns mock data)'
    },
    {
      name: 'Webhooks',
      description: 'Webhook endpoints for inbound SMS and email callbacks'
    }
  ]
};