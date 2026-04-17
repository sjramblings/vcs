import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Construct } from 'constructs';

export interface GatewayLayerProps {
  toolExecutorFn: lambda.IFunction;
}

// ─── Tool Schema Definitions (D-11 names, D-12 SchemaDefinitionType enums) ──
// Names match Phase 25 handler switch cases exactly.
// Target name 'vcs' means clients see vcs___read, vcs___ls, etc.

const TOOL_SCHEMAS: agentcore.ToolDefinition[] = [
  // ── Filesystem Tools ──
  {
    name: 'read',
    description: 'Read content at a specific detail level. L0=abstract (~100 tokens, cheap scanning). L1=structured overview (~2K tokens). L2=full content. Use L0 first to decide relevance, then L2 only when needed.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        uri: { type: agentcore.SchemaDefinitionType.STRING, description: 'viking:// URI to read' },
        level: { type: agentcore.SchemaDefinitionType.NUMBER, description: 'Detail level: 0=abstract, 1=overview, 2=full (default: 0)' },
      },
      required: ['uri'],
    },
  },
  {
    name: 'ls',
    description: 'List children of a directory URI. Returns child URIs with metadata for namespace browsing.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        uri: { type: agentcore.SchemaDefinitionType.STRING, description: 'viking:// directory URI to list' },
      },
      required: ['uri'],
    },
  },
  {
    name: 'tree',
    description: 'Show recursive directory tree from a URI. Useful for understanding namespace structure.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        uri: { type: agentcore.SchemaDefinitionType.STRING, description: 'viking:// root URI (e.g., viking://resources/)' },
        depth: { type: agentcore.SchemaDefinitionType.NUMBER, description: 'Maximum depth (default: 3, max: 10)' },
      },
      required: ['uri'],
    },
  },

  // ── Search Tools ──
  {
    name: 'find',
    description: 'Stateless semantic search. Returns L0 abstracts (~100 tokens each) ranked by relevance. Use for quick lookups without session context. Supports scope filtering.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        query: { type: agentcore.SchemaDefinitionType.STRING, description: 'Natural language search query' },
        scope: { type: agentcore.SchemaDefinitionType.STRING, description: 'URI prefix to restrict search (e.g., viking://resources/)' },
        max_results: { type: agentcore.SchemaDefinitionType.NUMBER, description: 'Maximum results (default: 5, max: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search',
    description: 'Session-aware search with intent analysis. Returns results grouped by type (resources, memories, skills). Requires an active session ID.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        query: { type: agentcore.SchemaDefinitionType.STRING, description: 'Natural language search query' },
        session_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Active session ID for context enrichment' },
        max_results: { type: agentcore.SchemaDefinitionType.NUMBER, description: 'Maximum results per type (default: 5)' },
      },
      required: ['query', 'session_id'],
    },
  },

  // ── Ingestion Tool ──
  {
    name: 'ingest',
    description: 'Ingest a markdown document. Generates L0 abstract, L1 overview, L2 full content, and vector embeddings. Document becomes searchable after ingestion.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        uri_prefix: { type: agentcore.SchemaDefinitionType.STRING, description: 'Parent directory URI ending with / (e.g., viking://resources/docs/)' },
        filename: { type: agentcore.SchemaDefinitionType.STRING, description: 'Filename for the document (e.g., my-doc.md)' },
        content: { type: agentcore.SchemaDefinitionType.STRING, description: 'Markdown content to ingest' },
        instruction: { type: agentcore.SchemaDefinitionType.STRING, description: 'Optional custom summarisation guidance' },
      },
      required: ['uri_prefix', 'filename', 'content'],
    },
  },

  // ── Session Tools ──
  {
    name: 'create_session',
    description: 'Create a new VCS session for tracking conversations. Returns a session ID.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {},
    },
  },
  {
    name: 'add_message',
    description: 'Record a conversation message in a session. Call after each turn to build context for session-aware search.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        session_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Session ID' },
        role: { type: agentcore.SchemaDefinitionType.STRING, description: 'Message role: user, assistant, system, or tool' },
        content: { type: agentcore.SchemaDefinitionType.STRING, description: 'Message text content' },
      },
      required: ['session_id', 'role', 'content'],
    },
  },
  {
    name: 'used',
    description: 'Record which context URIs were consulted during a session turn. Improves future search relevance.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        session_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Session ID' },
        uris: { type: agentcore.SchemaDefinitionType.ARRAY, description: 'URIs that were read/consulted', items: { type: agentcore.SchemaDefinitionType.STRING } },
        skill: { type: agentcore.SchemaDefinitionType.STRING, description: 'Skill name that was applied (optional)' },
      },
      required: ['session_id', 'uris'],
    },
  },
  {
    name: 'commit_session',
    description: 'Archive a session and extract memories. Call at conversation end. Generates summary, extracts memories using 6-category taxonomy, deduplicates against existing memories.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        session_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Session ID to commit' },
      },
      required: ['session_id'],
    },
  },
];

export class GatewayLayer extends Construct {
  public readonly gatewayUrl: string;
  public readonly gateway: agentcore.Gateway;

  constructor(scope: Construct, id: string, props: GatewayLayerProps) {
    super(scope, id);

    // Gateway with auto-provisioned Cognito
    this.gateway = new agentcore.Gateway(this, 'McpGateway', {
      gatewayName: 'vcs-mcp-gateway',                  
      description: 'Viking Context Service MCP Gateway',
      protocolConfiguration: new agentcore.McpProtocolConfiguration({
        supportedVersions: [agentcore.MCPProtocolVersion.MCP_2025_03_26],
        searchType: agentcore.McpGatewaySearchType.SEMANTIC,              
        instructions: 'This gateway provides tools to interact with Viking Context Service (VCS), a hierarchical context database for AI agents. Use find to search, read to load content at different detail levels (L0=abstract, L1=overview, L2=full), ls and tree to browse the namespace, ingest to add documents, and session tools to track conversations.',
      }),
      exceptionLevel: agentcore.GatewayExceptionLevel.DEBUG,
    });
    //: OAuth 2.1 with PKCE is automatic via auto-provisioned Cognito
    //: RFC 9728 Protected Resource Metadata is automatic via Gateway

    //: Register the tool executor Lambda as a target with 10 tool schemas
    this.gateway.addLambdaTarget('VcsTarget', {
      gatewayTargetName: 'vcs',
      description: 'VCS context database tools — filesystem, search, ingestion, sessions',
      lambdaFunction: props.toolExecutorFn,
      toolSchema: agentcore.ToolSchema.fromInline(TOOL_SCHEMAS),
    });

    // Gateway URL output (D-17: no hardcoded region — use gateway.gatewayUrl attribute)
    // The L2 construct provides gatewayUrl as a CloudFormation attribute
    this.gatewayUrl = this.gateway.gatewayUrl ?? cdk.Fn.join('', [
      'https://',
      this.gateway.gatewayId,
      '.gateway.bedrock-agentcore.',
      cdk.Stack.of(this).region,
      '.amazonaws.com/mcp',
    ]);

    new cdk.CfnOutput(scope, 'McpGatewayUrl', {
      value: this.gatewayUrl,
      description: 'VCS MCP Gateway URL (OAuth-protected, RFC 9728 discovery)',
    });

    new cdk.CfnOutput(scope, 'McpGatewayId', {
      value: this.gateway.gatewayId,
      description: 'AgentCore Gateway ID',
    });
  }
}
