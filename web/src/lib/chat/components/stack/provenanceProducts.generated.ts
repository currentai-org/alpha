// GENERATED FILE — do not edit by hand.
// Source: roadmap/roadmap.json (display_in_provenance === true)
// Regenerate: npm run build:roadmap

export type ProvenanceProductStatus = "live" | "building" | "gap";

export type ProvenanceProduct = {
	name: string;
	description: string | null;
	emoji: string;
	status: ProvenanceProductStatus;
	maintainers: string[];
	maintainers_url: string[];
	os_product: string | null;
	os_product_url: string | null;
	os_product_description: string | null;
	os_product_links: { label: string; url: string }[];
	os_options: string[];
	location?: string;
	map_links: Record<string, string>;
};

export const PROVENANCE_PRODUCTS: ProvenanceProduct[] = [
		{
			"name": "chat",
			"description": "Browser-based conversational client.",
			"emoji": "💬",
			"status": "live",
			"maintainers": [
				"Hugging Face"
			],
			"maintainers_url": [
				"https://huggingface.co"
			],
			"os_product": "chat-ui",
			"os_product_url": "https://github.com/huggingface/chat-ui",
			"os_product_description": "Open source chat interface for large language models.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/huggingface/chat-ui"
				}
			],
			"os_options": [
				"Open WebUI",
				"LibreChat",
				"Lobe Chat"
			],
			"map_links": {
				"chat-ui": "huggingchat-chat-ui"
			}
		},
		{
			"name": "inference-platform",
			"description": "Developer-facing API gateway and portal.",
			"emoji": "🌐",
			"status": "live",
			"maintainers": [
				"Public AI"
			],
			"maintainers_url": [
				"https://publicai.co"
			],
			"os_product": "Public AI Inference Utility",
			"os_product_url": "https://publicai.co",
			"os_product_description": "Developer-facing API gateway and portal for AI inference.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/forpublicai/platform.publicai.co"
				}
			],
			"os_options": [
				"LiteLLM",
				"Otari",
				"Portkey"
			],
			"map_links": {}
		},
		{
			"name": "compute-router",
			"description": "An inference module that routes inference requests across a distributed compute pool.",
			"emoji": "🔀",
			"status": "live",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": "LiteLLM",
			"os_product_url": "https://www.litellm.ai/",
			"os_product_description": "Call all LLM APIs using the OpenAI format.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/BerriAI/litellm"
				}
			],
			"os_options": [
				"LiteLLM",
				"vLLM multi-node",
				"Ray Serve",
				"llm-d (Red Hat)"
			],
			"map_links": {
				"LiteLLM": "litellm"
			}
		},
		{
			"name": "inference-engine",
			"description": "The core engine that connects to the hardware level, boots up the model, and serves inference efficiently into an API.",
			"emoji": "⚡",
			"status": "live",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": "vLLM",
			"os_product_url": "https://vllm.ai/",
			"os_product_description": "High-throughput and memory-efficient LLM inference and serving engine.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/vllm-project/vllm"
				}
			],
			"os_options": [
				"vLLM",
				"llama.cpp",
				"SGLang",
				"TGI (HF)"
			],
			"map_links": {
				"vLLM": "vllm"
			}
		},
		{
			"name": "foundation-model",
			"description": "The flagship open source foundation model and model family.",
			"emoji": "🧠",
			"status": "live",
			"maintainers": [
				"Swiss National AI Institute"
			],
			"maintainers_url": [
				"https://swiss-ai.org"
			],
			"os_product": "Apertus",
			"os_product_url": "https://huggingface.co/swiss-ai",
			"os_product_description": "Fully open source, trained by public institutions. Respects data-owner opt-out, even retroactively.",
			"os_product_links": [
				{
					"label": "HuggingFace",
					"url": "https://huggingface.co/swiss-ai/Apertus-v1.5-70B"
				},
				{
					"label": "Technical report",
					"url": "https://arxiv.org/abs/2509.14233"
				},
				{
					"label": "Data recipe",
					"url": "https://github.com/swiss-ai/pretrain-data"
				}
			],
			"os_options": [
				"Apertus",
				"OLMo",
				"Mistral",
				"LLaMa",
				"Command A"
			],
			"map_links": {
				"Apertus": "apertus"
			}
		},
		{
			"name": "trust-and-safety",
			"description": "Content moderation, incident response, T&C, and data governance.",
			"emoji": "🛡️",
			"status": "live",
			"maintainers": [
				"Mistral AI"
			],
			"maintainers_url": [
				"https://mistral.ai"
			],
			"os_product": "Shieldstral",
			"os_product_url": "https://huggingface.co/mistralai/Shieldstral-1.0-3B",
			"os_product_description": "Self-hosted open-weight safety judge screening every chat turn before it reaches the model.",
			"os_product_links": [
				{
					"label": "Hugging Face",
					"url": "https://huggingface.co/mistralai/Shieldstral-1.0-3B"
				}
			],
			"os_options": [
				"ROOST",
				"gpt-oss-safeguard",
				"Zentropi CoPE",
				"Llama Guard"
			],
			"map_links": {}
		},
		{
			"name": "model-router",
			"description": "An inference module that routes inference requests to different models based on parameters like use-case, intent, subscription class, and geography.",
			"emoji": "🎯",
			"status": "building",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": null,
			"os_product_url": null,
			"os_product_description": null,
			"os_product_links": [],
			"os_options": [
				"Omni (now Plano)",
				"RouteLLM",
				"LiteLLM router",
				"Martian"
			],
			"map_links": {}
		},
		{
			"name": "agent-service",
			"description": "A hosted service for deploying and configuring agents.",
			"emoji": "🤖",
			"status": "building",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": "Pi, Hermes Agent",
			"os_product_url": "https://pi.dev, https://github.com/nousresearch/hermes-agent",
			"os_product_description": "Personal AI and open source agentic models.",
			"os_product_links": [
				{
					"label": "GitHub (Hermes)",
					"url": "https://github.com/nousresearch/hermes-agent"
				}
			],
			"os_options": [
				"Hermes Agent (Nous)",
				"OpenHands",
				"LangGraph",
				"AutoGen"
			],
			"map_links": {
				"Pi, Hermes Agent": "hermes-agent"
			}
		},
		{
			"name": "mobile-app",
			"description": "Native iOS and Android client.",
			"emoji": "📱",
			"status": "gap",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": null,
			"os_product_url": null,
			"os_product_description": null,
			"os_product_links": [],
			"os_options": [
				"HuggingChat mobile",
				"Ollama (via API)",
				"Pocketpal-AI"
			],
			"map_links": {}
		},
		{
			"name": "skills-framework",
			"description": "An open marketplace and authoring surface for reusable, composable model capabilities.",
			"emoji": "🧩",
			"status": "gap",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": null,
			"os_product_url": null,
			"os_product_description": null,
			"os_product_links": [],
			"os_options": [
				"LangChain tools",
				"MCP servers",
				"Semantic Kernel plugins"
			],
			"map_links": {}
		},
		{
			"name": "rag",
			"description": "Retrieval-augmented generation module for incorporating external knowledge.",
			"emoji": "📚",
			"status": "live",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": "custom deployment, for now",
			"os_product_url": null,
			"os_product_description": "Looking for partner. For now, we have a custom lightweight RAG built on HF Inference embeddings (MiniLM), in-memory cosine similarity search (no vector DB), BAAI reranking, custom chunking/parsing.",
			"os_product_links": [],
			"os_options": [
				"LlamaIndex",
				"LangChain",
				"Haystack (deepset)",
				"RAGFlow",
				"txtai"
			],
			"map_links": {}
		},
		{
			"name": "web-search",
			"description": "Search module or search agent to allow models to query live information from the web.",
			"emoji": "🔍",
			"status": "live",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": "Firecrawl",
			"os_product_url": "https://firecrawl.dev/",
			"os_product_description": "Firecrawl's open source scraper (AGPL-3.0) reads each page. The search that finds those pages is Firecrawl's own hosted service, which is closed and doesn't say which search index it draws on.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/firecrawl/firecrawl"
				}
			],
			"os_options": [
				"Marginalia",
				"Firecrawl",
				"SearXNG",
				"Perplexica",
				"OpenDeepSearch",
				"Morphic"
			],
			"map_links": {
				"Firecrawl": "firecrawl"
			}
		},
		{
			"name": "stack-provenance",
			"description": "Tracking and verification of the origin and lineage of stack components, per query.",
			"emoji": "🔗",
			"status": "live",
			"maintainers": [
				"Current AI"
			],
			"maintainers_url": [
				"https://currentai.org"
			],
			"os_product": "Stack X-Ray",
			"os_product_url": "https://aipotluck.org/chat",
			"os_product_description": "Tooling for tracking and displaying the origin of AI stack components.",
			"os_product_links": [],
			"os_options": [
				"No purpose-built OSS option; adjacent: Sigstore",
				"in-toto / SLSA provenance",
				"Hugging Face model cards"
			],
			"map_links": {}
		},
		{
			"name": "voice-output",
			"description": "Text-to-speech module for generating spoken responses.",
			"emoji": "🔊",
			"status": "live",
			"maintainers": [
				"Hugging Face",
				"community"
			],
			"maintainers_url": [
				"https://huggingface.co"
			],
			"os_product": "Hugging Face Spaces",
			"os_product_url": "https://huggingface.co/spaces",
			"os_product_description": "Platform for building and sharing machine learning applications.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/huggingface"
				}
			],
			"os_options": [
				"Coqui TTS",
				"Piper (OHF)",
				"Kokoro",
				"XTTS",
				"Orpheus"
			],
			"map_links": {}
		},
		{
			"name": "federated-rag",
			"description": "Distributed retrieval-augmented generation across multiple knowledge bases.",
			"emoji": "🔒",
			"status": "live",
			"maintainers": [
				"OpenMined"
			],
			"maintainers_url": [
				"https://openmined.org"
			],
			"os_product": "SyftHub",
			"os_product_url": "https://github.com/OpenMined/PySyft",
			"os_product_description": "Platform for privacy-preserving federated learning and retrieval.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/OpenMined/PySyft"
				}
			],
			"os_options": [
				"OpenMined PySyft / SyftHub",
				"Flower",
				"FedML; standard RAG layer: LlamaIndex",
				"Haystack"
			],
			"map_links": {}
		},
		{
			"name": "stack-telemetry",
			"description": "System-wide logging, monitoring, and observability infrastructure.",
			"emoji": "📡",
			"status": "gap",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": null,
			"os_product_url": null,
			"os_product_description": null,
			"os_product_links": [],
			"os_options": [
				"OpenTelemetry",
				"Grafana / Prometheus",
				"Langfuse",
				"OpenLLMetry (Traceloop)",
				"Phoenix (Arize)"
			],
			"map_links": {}
		},
		{
			"name": "projects",
			"description": "Organize chats and context in frontends; automated RAG and context curation.",
			"emoji": "📁",
			"status": "gap",
			"maintainers": [],
			"maintainers_url": [],
			"os_product": null,
			"os_product_url": null,
			"os_product_description": null,
			"os_product_links": [],
			"os_options": [
				"Open WebUI (workspaces)",
				"LibreChat",
				"AnythingLLM",
				"Khoj"
			],
			"map_links": {}
		},
		{
			"name": "api-management",
			"description": "API usage management, rate-limiting, and billing.",
			"emoji": "💳",
			"status": "live",
			"maintainers": [
				"Mozilla.ai"
			],
			"maintainers_url": [
				"https://mozilla.ai"
			],
			"os_product": "Otari",
			"os_product_url": "https://otari.ai",
			"os_product_description": "API usage management, rate-limiting, and billing for AI models.",
			"os_product_links": [
				{
					"label": "GitHub",
					"url": "https://github.com/mozilla-ai/otari"
				}
			],
			"os_options": [
				"Otari"
			],
			"map_links": {}
		},
		{
			"name": "sovereign-compute",
			"description": "Sovereign compute for inference, owned by the public.",
			"emoji": "🚅",
			"status": "live",
			"maintainers": [
				"Swiss National Supercomputing Centre"
			],
			"maintainers_url": [
				"https://cscs.ch"
			],
			"os_product": "Swiss National Supercomputing Centre",
			"os_product_url": "https://cscs.ch",
			"os_product_description": "Sovereign compute, cooled by the waters of Lake Lugano and fed entirely by hydropower, hosted by CSCS in Lugano, Switzerland.",
			"os_product_links": [
				{
					"label": "CSCS",
					"url": "https://cscs.ch"
				}
			],
			"os_options": [],
			"location": "Lugano, Switzerland",
			"map_links": {}
		}
	];
