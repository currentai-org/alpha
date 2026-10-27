// GENERATED FILE — do not edit by hand.
// Source: roadmap/roadmap.json (display_in_provenance === true) + roadmap/stackLayout.json
// (layer/bucket/path have no Sheet column — CUR-91).
// Regenerate: npm run build:roadmap

import type { RoadmapProduct } from "./stackRoadmap";

export const ROADMAP_PRODUCTS: RoadmapProduct[] = [
		{
			"id": "chat",
			"name": "chat",
			"layer": "clients",
			"bucket": "now",
			"status": "live",
			"path": 1,
			"desc": "Browser-based conversational client.",
			"osProduct": "chat-ui",
			"osOptions": [
				"Open WebUI",
				"LibreChat",
				"Lobe Chat"
			],
			"maintainers": [
				"Hugging Face"
			],
			"url": "https://github.com/huggingface/chat-ui"
		},
		{
			"id": "inference-platform",
			"name": "inference-platform",
			"layer": "serving",
			"bucket": "now",
			"status": "live",
			"path": 5,
			"desc": "Developer-facing API gateway and portal.",
			"osProduct": "Public AI Inference Utility",
			"osOptions": [
				"LiteLLM",
				"Otari",
				"Portkey"
			],
			"maintainers": [
				"Public AI"
			],
			"url": "https://publicai.co"
		},
		{
			"id": "compute-router",
			"name": "compute-router",
			"layer": "orchestration",
			"bucket": "now",
			"status": "live",
			"path": 8,
			"desc": "An inference module that routes inference requests across a distributed compute pool.",
			"osProduct": "LiteLLM",
			"osOptions": [
				"LiteLLM",
				"vLLM multi-node",
				"Ray Serve",
				"llm-d (Red Hat)"
			],
			"url": "https://www.litellm.ai/"
		},
		{
			"id": "inference-engine",
			"name": "inference-engine",
			"layer": "serving",
			"bucket": "now",
			"status": "live",
			"path": 6,
			"desc": "The core engine that connects to the hardware level, boots up the model, and serves inference efficiently into an API.",
			"osProduct": "vLLM",
			"osOptions": [
				"vLLM",
				"llama.cpp",
				"SGLang",
				"TGI (HF)"
			],
			"url": "https://vllm.ai/"
		},
		{
			"id": "foundation-model",
			"name": "foundation-model",
			"layer": "models",
			"bucket": "now",
			"status": "live",
			"path": 7,
			"desc": "The flagship open source foundation model and model family.",
			"osProduct": "Apertus",
			"osOptions": [
				"Apertus",
				"OLMo",
				"Mistral",
				"LLaMa",
				"Command A"
			],
			"maintainers": [
				"Swiss National AI Institute"
			],
			"url": "https://huggingface.co/swiss-ai",
			"provenance": "Open weights, open data, open training recipe. 15T tokens across 1811 languages. Respects data-owner opt-out, even retroactively.",
			"provenanceLinks": [
				{
					"label": "Technical report",
					"url": "https://arxiv.org/abs/2509.14233"
				},
				{
					"label": "Data recipe",
					"url": "https://github.com/swiss-ai/pretrain-data"
				}
			]
		},
		{
			"id": "trust-and-safety",
			"name": "trust-and-safety",
			"layer": "trust",
			"bucket": "now",
			"status": "live",
			"path": 0,
			"desc": "Content moderation, incident response, T&C, and data governance.",
			"osProduct": "Shieldstral",
			"osOptions": [
				"ROOST",
				"gpt-oss-safeguard",
				"Zentropi CoPE",
				"Llama Guard"
			],
			"maintainers": [
				"Mistral AI"
			],
			"url": "https://huggingface.co/mistralai/Shieldstral-1.0-3B"
		},
		{
			"id": "model-router",
			"name": "model-router",
			"layer": "orchestration",
			"bucket": "next",
			"status": "building",
			"path": 0,
			"desc": "An inference module that routes inference requests to different models based on parameters like use-case, intent, subscription class, and geography.",
			"osOptions": [
				"Omni (now Plano)",
				"RouteLLM",
				"LiteLLM router",
				"Martian"
			]
		},
		{
			"id": "agent-service",
			"name": "agent-service",
			"layer": "agents",
			"bucket": "next",
			"status": "building",
			"path": 0,
			"desc": "A hosted service for deploying and configuring agents.",
			"osProduct": "Pi, Hermes Agent",
			"osOptions": [
				"Hermes Agent (Nous)",
				"OpenHands",
				"LangGraph",
				"AutoGen"
			],
			"url": "https://pi.dev, https://github.com/nousresearch/hermes-agent"
		},
		{
			"id": "mobile-app",
			"name": "mobile-app",
			"layer": "clients",
			"bucket": "later",
			"status": "gap",
			"path": 0,
			"desc": "Native iOS and Android client.",
			"osOptions": [
				"HuggingChat mobile",
				"Ollama (via API)",
				"Pocketpal-AI"
			]
		},
		{
			"id": "skills-framework",
			"name": "skills-framework",
			"layer": "agents",
			"bucket": "later",
			"status": "gap",
			"path": 0,
			"desc": "An open marketplace and authoring surface for reusable, composable model capabilities.",
			"osOptions": [
				"LangChain tools",
				"MCP servers",
				"Semantic Kernel plugins"
			]
		},
		{
			"id": "rag",
			"name": "rag",
			"layer": "knowledge",
			"bucket": "now",
			"status": "live",
			"path": 2,
			"desc": "Retrieval-augmented generation module for incorporating external knowledge.",
			"osProduct": "custom deployment, for now",
			"osOptions": [
				"LlamaIndex",
				"LangChain",
				"Haystack (deepset)",
				"RAGFlow",
				"txtai"
			]
		},
		{
			"id": "web-search",
			"name": "web-search",
			"layer": "knowledge",
			"bucket": "now",
			"status": "live",
			"path": 3,
			"desc": "Search module or search agent to allow models to query live information from the web.",
			"osProduct": "Firecrawl",
			"osOptions": [
				"Marginalia",
				"Firecrawl",
				"SearXNG",
				"Perplexica",
				"OpenDeepSearch",
				"Morphic"
			],
			"url": "https://firecrawl.dev/"
		},
		{
			"id": "stack-provenance",
			"name": "stack-provenance",
			"layer": "trust",
			"bucket": "now",
			"status": "live",
			"path": 9,
			"desc": "Tracking and verification of the origin and lineage of stack components, per query.",
			"osProduct": "Stack X-Ray",
			"osOptions": [
				"No purpose-built OSS option; adjacent: Sigstore",
				"in-toto / SLSA provenance",
				"Hugging Face model cards"
			],
			"maintainers": [
				"Current AI"
			],
			"url": "https://aipotluck.org/chat"
		},
		{
			"id": "voice-output",
			"name": "voice-output",
			"layer": "clients",
			"bucket": "now",
			"status": "live",
			"path": 0,
			"desc": "Text-to-speech module for generating spoken responses.",
			"osProduct": "Hugging Face Spaces",
			"osOptions": [
				"Coqui TTS",
				"Piper (OHF)",
				"Kokoro",
				"XTTS",
				"Orpheus"
			],
			"maintainers": [
				"Hugging Face",
				"community"
			],
			"url": "https://huggingface.co/spaces"
		},
		{
			"id": "federated-rag",
			"name": "federated-rag",
			"layer": "knowledge",
			"bucket": "now",
			"status": "live",
			"path": 4,
			"desc": "Distributed retrieval-augmented generation across multiple knowledge bases.",
			"osProduct": "SyftHub",
			"osOptions": [
				"OpenMined PySyft / SyftHub",
				"Flower",
				"FedML; standard RAG layer: LlamaIndex",
				"Haystack"
			],
			"maintainers": [
				"OpenMined"
			],
			"url": "https://github.com/OpenMined/PySyft"
		},
		{
			"id": "stack-telemetry",
			"name": "stack-telemetry",
			"layer": "trust",
			"bucket": "later",
			"status": "gap",
			"path": 0,
			"desc": "System-wide logging, monitoring, and observability infrastructure.",
			"osOptions": [
				"OpenTelemetry",
				"Grafana / Prometheus",
				"Langfuse",
				"OpenLLMetry (Traceloop)",
				"Phoenix (Arize)"
			]
		},
		{
			"id": "projects",
			"name": "projects",
			"layer": "knowledge",
			"bucket": "later",
			"status": "gap",
			"path": 0,
			"desc": "Organize chats and context in frontends; automated RAG and context curation.",
			"osOptions": [
				"Open WebUI (workspaces)",
				"LibreChat",
				"AnythingLLM",
				"Khoj"
			]
		},
		{
			"id": "api-management",
			"name": "api-management",
			"layer": "orchestration",
			"bucket": "now",
			"status": "live",
			"path": 0,
			"desc": "API usage management, rate-limiting, and billing.",
			"osProduct": "Otari",
			"osOptions": [
				"Otari"
			],
			"maintainers": [
				"Mozilla.ai"
			],
			"url": "https://otari.ai"
		},
		{
			"id": "sovereign-compute",
			"name": "sovereign-compute",
			"layer": "compute",
			"bucket": "now",
			"status": "live",
			"path": 0,
			"desc": "Sovereign compute for inference, owned by the public.",
			"osProduct": "Swiss National Supercomputing Centre",
			"maintainers": [
				"Swiss National Supercomputing Centre"
			],
			"url": "https://cscs.ch",
			"provenance": "Public infrastructure, not a company: CSCS is a unit of ETH Zürich, publicly funded. It trained Apertus on its Alps supercomputer.",
			"provenanceLinks": [
				{
					"label": "cscs.ch",
					"url": "https://www.cscs.ch"
				},
				{
					"label": "SNAI · Apertus",
					"url": "https://huggingface.co/swiss-ai"
				}
			]
		}
	];
