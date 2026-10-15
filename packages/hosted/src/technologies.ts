/**
 * The curated table of libraries, frameworks and tools a biography may name (ADR-0014). Data,
 * not rules: detect.ts decides what a repository shows, and the biography resolves names and
 * kinds from here at render time, so a rename needs no data migration.
 */

export const TECHNOLOGY_KINDS = [
  "web framework",
  "UI library",
  "machine learning",
  "data",
  "database",
  "testing",
  "build tool",
  "infrastructure",
  "AI API",
  "graphics",
  "CLI",
  "other",
] as const;
export type TechnologyKind = (typeof TECHNOLOGY_KINDS)[number];

/** Within a project, frameworks come before tools (ADR-0014). */
export const KIND_PRIORITY: readonly TechnologyKind[] = [
  "web framework",
  "UI library",
  "machine learning",
  "AI API",
  "data",
  "database",
  "graphics",
  "CLI",
  "other",
  "testing",
  "build tool",
  "infrastructure",
];

export const ECOSYSTEMS = ["npm", "pypi", "crates", "go"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface Technology {
  id: string;
  name: string;
  kind: TechnologyKind;
  /** Package names per ecosystem; a trailing `*` matches any name with that prefix. */
  packages: Partial<Record<Ecosystem, readonly string[]>>;
  /** Import names beyond the package names (`sklearn`, `cv2`); Python ones match dotted prefixes. */
  imports?: Partial<Record<Ecosystem, readonly string[]>>;
  /** Container images in compose files, by repository name without registry or tag. */
  images?: readonly string[];
  /** Files whose presence is the evidence (infrastructure, lockfiles). */
  paths?: readonly RegExp[];
  /** Used through a command or configuration, not an import: its declaration is the evidence. */
  tool?: true;
}

type Spec = Omit<Technology, "id" | "name" | "kind" | "packages"> & Technology["packages"];

const t = (id: string, name: string, kind: TechnologyKind, spec: Spec = {}): Technology => {
  const { npm, pypi, crates, go, imports, images, paths, tool } = spec;
  return {
    id,
    name,
    kind,
    packages: {
      ...(npm && { npm }),
      ...(pypi && { pypi }),
      ...(crates && { crates }),
      ...(go && { go }),
    },
    ...(imports && { imports }),
    ...(images && { images }),
    ...(paths && { paths }),
    ...(tool && { tool }),
  };
};

/** A file named `name` anywhere in the tree. */
const file = (name: string) => new RegExp(`(?:^|/)${name.replace(/\./g, "\\.")}$`);

export const TECHNOLOGIES: readonly Technology[] = [
  // JavaScript and TypeScript: frameworks and UI
  t("react", "React", "UI library", { npm: ["react", "react-dom"] }),
  t("next-js", "Next.js", "web framework", { npm: ["next"] }),
  t("vue", "Vue.js", "UI library", { npm: ["vue"] }),
  t("nuxt", "Nuxt", "web framework", { npm: ["nuxt"] }),
  t("svelte", "Svelte", "UI library", { npm: ["svelte"] }),
  t("sveltekit", "SvelteKit", "web framework", { npm: ["@sveltejs/kit"] }),
  t("angular", "Angular", "web framework", { npm: ["@angular/*"] }),
  t("solid", "SolidJS", "UI library", { npm: ["solid-js"] }),
  t("preact", "Preact", "UI library", { npm: ["preact"] }),
  t("astro", "Astro", "web framework", { npm: ["astro", "@astrojs/*"] }),
  t("remix", "Remix", "web framework", { npm: ["@remix-run/*"] }),
  t("express", "Express", "web framework", { npm: ["express"] }),
  t("fastify", "Fastify", "web framework", { npm: ["fastify", "@fastify/*"] }),
  t("koa", "Koa", "web framework", { npm: ["koa"] }),
  t("hono", "Hono", "web framework", { npm: ["hono"] }),
  t("nestjs", "NestJS", "web framework", { npm: ["@nestjs/*"] }),
  t("trpc", "tRPC", "web framework", { npm: ["@trpc/*"] }),
  t("react-router", "React Router", "UI library", { npm: ["react-router", "react-router-dom"] }),
  t("react-native", "React Native", "UI library", { npm: ["react-native"] }),
  t("expo", "Expo", "UI library", { npm: ["expo"] }),
  t("electron", "Electron", "UI library", { npm: ["electron"] }),
  t("tauri", "Tauri", "UI library", { npm: ["@tauri-apps/*"], crates: ["tauri"] }),
  t("tailwind-css", "Tailwind CSS", "UI library", {
    npm: ["tailwindcss", "@tailwindcss/*"],
    tool: true,
  }),
  t("styled-components", "styled-components", "UI library", { npm: ["styled-components"] }),
  t("emotion", "Emotion", "UI library", { npm: ["@emotion/*"] }),
  t("mui", "MUI", "UI library", { npm: ["@mui/*"] }),
  t("chakra-ui", "Chakra UI", "UI library", { npm: ["@chakra-ui/*"] }),
  t("radix-ui", "Radix UI", "UI library", { npm: ["@radix-ui/*", "radix-ui"] }),
  t("headless-ui", "Headless UI", "UI library", { npm: ["@headlessui/*"] }),
  t("bootstrap", "Bootstrap", "UI library", { npm: ["bootstrap", "react-bootstrap"] }),
  t("ant-design", "Ant Design", "UI library", { npm: ["antd"] }),
  t("framer-motion", "Framer Motion", "UI library", { npm: ["framer-motion", "motion"] }),
  t("react-markdown", "react-markdown", "UI library", { npm: ["react-markdown"] }),
  t("storybook", "Storybook", "build tool", { npm: ["storybook", "@storybook/*"] }),
  // JavaScript and TypeScript: data, state and utilities
  t("tanstack-query", "TanStack Query", "data", {
    npm: ["@tanstack/react-query", "@tanstack/vue-query", "@tanstack/query-core"],
  }),
  t("redux", "Redux", "data", { npm: ["redux", "@reduxjs/toolkit", "react-redux"] }),
  t("zustand", "Zustand", "data", { npm: ["zustand"] }),
  t("zod", "Zod", "data", { npm: ["zod"] }),
  t("graphql", "GraphQL", "data", { npm: ["graphql"], pypi: ["graphene", "strawberry-graphql"] }),
  t("apollo", "Apollo GraphQL", "data", { npm: ["@apollo/*"] }),
  t("axios", "Axios", "other", { npm: ["axios"] }),
  t("date-fns", "date-fns", "other", { npm: ["date-fns"] }),
  t("day-js", "Day.js", "other", { npm: ["dayjs"] }),
  t("lodash", "Lodash", "other", { npm: ["lodash", "lodash-es"] }),
  t("rxjs", "RxJS", "other", { npm: ["rxjs"] }),
  t("socket-io", "Socket.IO", "other", {
    npm: ["socket.io", "socket.io-client"],
    pypi: ["python-socketio"],
    imports: { pypi: ["socketio"] },
  }),
  t("stripe", "Stripe", "other", { npm: ["stripe", "@stripe/*"], pypi: ["stripe"] }),
  t("dotenv", "dotenv", "other", {
    npm: ["dotenv"],
    pypi: ["python-dotenv"],
    imports: { pypi: ["dotenv"] },
  }),
  t("commander", "Commander.js", "CLI", { npm: ["commander"] }),
  t("yargs", "yargs", "CLI", { npm: ["yargs"] }),
  t("ink", "Ink", "CLI", { npm: ["ink"] }),
  // Graphics and charts
  t("mermaid", "Mermaid", "graphics", { npm: ["mermaid"] }),
  t("d3", "D3.js", "graphics", { npm: ["d3", "d3-*"] }),
  t("chart-js", "Chart.js", "graphics", { npm: ["chart.js", "react-chartjs-2"] }),
  t("recharts", "Recharts", "graphics", { npm: ["recharts"] }),
  t("three-js", "three.js", "graphics", { npm: ["three"] }),
  t("react-three-fiber", "React Three Fiber", "graphics", { npm: ["@react-three/*"] }),
  t("pixi-js", "PixiJS", "graphics", { npm: ["pixi.js"] }),
  t("leaflet", "Leaflet", "graphics", { npm: ["leaflet", "react-leaflet"] }),
  t("mapbox", "Mapbox GL", "graphics", { npm: ["mapbox-gl"] }),
  t("plotly", "Plotly", "graphics", { npm: ["plotly.js", "react-plotly.js"], pypi: ["plotly"] }),
  t("matplotlib", "Matplotlib", "graphics", { pypi: ["matplotlib"] }),
  t("seaborn", "seaborn", "graphics", { pypi: ["seaborn"] }),
  t("pillow", "Pillow", "graphics", { pypi: ["pillow"], imports: { pypi: ["PIL"] } }),
  t("scikit-image", "scikit-image", "graphics", {
    pypi: ["scikit-image"],
    imports: { pypi: ["skimage"] },
  }),
  t("pygame", "Pygame", "graphics", { pypi: ["pygame", "pygame-ce"] }),
  t("bevy", "Bevy", "graphics", { crates: ["bevy"] }),
  t("wgpu", "wgpu", "graphics", { crates: ["wgpu"] }),
  // Build tools and package managers
  t("vite", "Vite", "build tool", { npm: ["vite", "@vitejs/*"] }),
  t("webpack", "webpack", "build tool", { npm: ["webpack", "webpack-cli"] }),
  t("esbuild", "esbuild", "build tool", { npm: ["esbuild"] }),
  t("rollup", "Rollup", "build tool", { npm: ["rollup", "@rollup/*"] }),
  t("parcel", "Parcel", "build tool", { npm: ["parcel"] }),
  t("babel", "Babel", "build tool", { npm: ["@babel/*"] }),
  t("swc", "SWC", "build tool", { npm: ["@swc/*"] }),
  t("turborepo", "Turborepo", "build tool", { npm: ["turbo"], paths: [/^turbo\.json$/] }),
  t("nx", "Nx", "build tool", { npm: ["nx", "@nx/*"] }),
  t("pagefind", "Pagefind", "build tool", { npm: ["pagefind"] }),
  t("pnpm", "pnpm", "build tool", { paths: [file("pnpm-lock.yaml"), file("pnpm-workspace.yaml")] }),
  t("yarn", "Yarn", "build tool", { paths: [file("yarn.lock")] }),
  t("bun", "Bun", "build tool", { paths: [file("bun.lockb"), file("bun.lock")] }),
  t("poetry", "Poetry", "build tool", {
    pypi: ["poetry", "poetry-core"],
    paths: [file("poetry.lock")],
  }),
  t("uv", "uv", "build tool", { pypi: ["uv"], paths: [file("uv.lock")] }),
  t("hatch", "Hatch", "build tool", { pypi: ["hatchling", "hatch"] }),
  t("maturin", "maturin", "build tool", { pypi: ["maturin"] }),
  t("cython", "Cython", "build tool", { pypi: ["cython"], paths: [/\.pyx$/] }),
  t("wasm-bindgen", "wasm-bindgen", "build tool", { crates: ["wasm-bindgen"] }),
  // Testing
  t("vitest", "Vitest", "testing", { npm: ["vitest", "@vitest/*"] }),
  t("jest", "Jest", "testing", { npm: ["jest", "ts-jest", "@jest/*"] }),
  t("mocha", "Mocha", "testing", { npm: ["mocha"] }),
  t("playwright", "Playwright", "testing", {
    npm: ["@playwright/test", "playwright"],
    pypi: ["playwright", "pytest-playwright"],
  }),
  t("cypress", "Cypress", "testing", { npm: ["cypress"] }),
  t("testing-library", "Testing Library", "testing", { npm: ["@testing-library/*"] }),
  t("jsdom", "jsdom", "testing", { npm: ["jsdom", "happy-dom"] }),
  t("msw", "Mock Service Worker", "testing", { npm: ["msw"] }),
  t("supertest", "SuperTest", "testing", { npm: ["supertest"] }),
  t("pytest", "pytest", "testing", { pypi: ["pytest", "pytest-*"] }),
  t("hypothesis", "Hypothesis", "testing", { pypi: ["hypothesis"] }),
  t("moto", "Moto", "testing", { pypi: ["moto"] }),
  t("selenium", "Selenium", "testing", { npm: ["selenium-webdriver"], pypi: ["selenium"] }),
  t("locust", "Locust", "testing", { pypi: ["locust"] }),
  t("proptest", "proptest", "testing", { crates: ["proptest"] }),
  t("criterion", "Criterion.rs", "testing", { crates: ["criterion"] }),
  t("insta", "insta", "testing", { crates: ["insta"] }),
  t("testify", "Testify", "testing", { go: ["github.com/stretchr/testify"] }),
  // Python: web, services and utilities
  t("fastapi", "FastAPI", "web framework", { pypi: ["fastapi"] }),
  t("flask", "Flask", "web framework", { pypi: ["flask", "flask-*"] }),
  t("django", "Django", "web framework", { pypi: ["django"] }),
  t("django-rest-framework", "Django REST framework", "web framework", {
    pypi: ["djangorestframework"],
    imports: { pypi: ["rest_framework"] },
  }),
  t("starlette", "Starlette", "web framework", { pypi: ["starlette"] }),
  t("aiohttp", "aiohttp", "web framework", { pypi: ["aiohttp"] }),
  t("tornado", "Tornado", "web framework", { pypi: ["tornado"] }),
  t("streamlit", "Streamlit", "UI library", { pypi: ["streamlit"] }),
  t("gradio", "Gradio", "UI library", { pypi: ["gradio"] }),
  t("dash", "Dash", "UI library", { pypi: ["dash"] }),
  t("uvicorn", "Uvicorn", "infrastructure", { pypi: ["uvicorn"], tool: true }),
  t("gunicorn", "Gunicorn", "infrastructure", { pypi: ["gunicorn"], tool: true }),
  t("mangum", "Mangum", "other", { pypi: ["mangum"] }),
  t("pydantic", "Pydantic", "data", { pypi: ["pydantic", "pydantic-settings"] }),
  t("httpx", "HTTPX", "other", { pypi: ["httpx"] }),
  t("requests", "Requests", "other", { pypi: ["requests"] }),
  t("websockets", "websockets", "other", { pypi: ["websockets"] }),
  t("celery", "Celery", "other", { pypi: ["celery"] }),
  t("apscheduler", "APScheduler", "other", { pypi: ["apscheduler"] }),
  t("tenacity", "Tenacity", "other", { pypi: ["tenacity"] }),
  t("loguru", "Loguru", "other", { pypi: ["loguru"] }),
  t("dateutil", "dateutil", "other", {
    pypi: ["python-dateutil"],
    imports: { pypi: ["dateutil"] },
  }),
  t("cryptography", "cryptography", "other", { pypi: ["cryptography"] }),
  t("pyjwt", "PyJWT", "other", { pypi: ["pyjwt"], imports: { pypi: ["jwt"] } }),
  t("click", "Click", "CLI", { pypi: ["click"] }),
  t("typer", "Typer", "CLI", { pypi: ["typer"] }),
  t("rich", "Rich", "CLI", { pypi: ["rich"] }),
  t("textual", "Textual", "CLI", { pypi: ["textual"] }),
  t("tqdm", "tqdm", "CLI", { pypi: ["tqdm"] }),
  t("beautiful-soup", "Beautiful Soup", "data", {
    pypi: ["beautifulsoup4"],
    imports: { pypi: ["bs4"] },
  }),
  t("scrapy", "Scrapy", "data", { pypi: ["scrapy"] }),
  t("feedparser", "feedparser", "data", { pypi: ["feedparser"] }),
  t("pypdf", "pypdf", "data", { pypi: ["pypdf", "pypdf2"], imports: { pypi: ["PyPDF2"] } }),
  t("garmin-connect", "Garmin Connect", "data", { pypi: ["garminconnect"] }),
  t("catanatron", "Catanatron", "other", { pypi: ["catanatron"] }),
  t("phevaluator", "PokerHandEvaluator", "other", { pypi: ["phevaluator"] }),
  // Machine learning and data science
  t("numpy", "NumPy", "data", { pypi: ["numpy"] }),
  t("pandas", "pandas", "data", { pypi: ["pandas"] }),
  t("scipy", "SciPy", "data", { pypi: ["scipy"] }),
  t("polars", "Polars", "data", { pypi: ["polars"], crates: ["polars"] }),
  t("apache-arrow", "Apache Arrow", "data", {
    pypi: ["pyarrow"],
    crates: ["arrow"],
    npm: ["apache-arrow"],
  }),
  t("sympy", "SymPy", "data", { pypi: ["sympy"] }),
  t("networkx", "NetworkX", "data", { pypi: ["networkx"] }),
  t("numba", "Numba", "data", { pypi: ["numba"] }),
  t("jupyter", "Jupyter", "data", {
    pypi: ["jupyter", "jupyterlab", "notebook", "ipykernel"],
    paths: [/\.ipynb$/],
    tool: true,
  }),
  t("scikit-learn", "scikit-learn", "machine learning", {
    pypi: ["scikit-learn", "sklearn"],
    imports: { pypi: ["sklearn"] },
  }),
  t("pytorch", "PyTorch", "machine learning", { pypi: ["torch", "torchvision", "torchaudio"] }),
  t("pytorch-lightning", "PyTorch Lightning", "machine learning", {
    pypi: ["lightning", "pytorch-lightning"],
  }),
  t("tensorflow", "TensorFlow", "machine learning", {
    pypi: ["tensorflow", "tensorflow-cpu"],
    npm: ["@tensorflow/*"],
  }),
  t("keras", "Keras", "machine learning", { pypi: ["keras"] }),
  t("jax", "JAX", "machine learning", { pypi: ["jax", "jaxlib", "flax"] }),
  t("xgboost", "XGBoost", "machine learning", { pypi: ["xgboost"] }),
  t("lightgbm", "LightGBM", "machine learning", { pypi: ["lightgbm"] }),
  t("statsmodels", "statsmodels", "machine learning", { pypi: ["statsmodels"] }),
  t("opencv", "OpenCV", "machine learning", {
    pypi: ["opencv-python", "opencv-python-headless", "opencv-contrib-python"],
    crates: ["opencv"],
    imports: { pypi: ["cv2"] },
  }),
  t("transformers", "Hugging Face Transformers", "machine learning", {
    pypi: ["transformers"],
    npm: ["@huggingface/transformers"],
  }),
  t("sentence-transformers", "Sentence Transformers", "machine learning", {
    pypi: ["sentence-transformers"],
  }),
  t("spacy", "spaCy", "machine learning", { pypi: ["spacy"] }),
  t("nltk", "NLTK", "machine learning", { pypi: ["nltk"] }),
  t("gymnasium", "Gymnasium", "machine learning", { pypi: ["gymnasium", "gym"] }),
  t("stable-baselines3", "Stable-Baselines3", "machine learning", { pypi: ["stable-baselines3"] }),
  t("mediapipe", "MediaPipe", "machine learning", { npm: ["@mediapipe/*"], pypi: ["mediapipe"] }),
  t("onnx-runtime", "ONNX Runtime", "machine learning", {
    pypi: ["onnxruntime", "onnxruntime-gpu"],
    npm: ["onnxruntime-web", "onnxruntime-node"],
  }),
  t("mlflow", "MLflow", "machine learning", { pypi: ["mlflow"] }),
  t("wandb", "Weights & Biases", "machine learning", { pypi: ["wandb"] }),
  t("ray", "Ray", "machine learning", { pypi: ["ray"] }),
  // AI APIs
  t("anthropic", "Anthropic API", "AI API", { npm: ["@anthropic-ai/sdk"], pypi: ["anthropic"] }),
  t("openai", "OpenAI API", "AI API", { npm: ["openai"], pypi: ["openai"] }),
  t("gemini", "Gemini API", "AI API", {
    npm: ["@google/generative-ai", "@google/genai"],
    pypi: ["google-generativeai", "google-genai"],
    imports: { pypi: ["google.generativeai", "google.genai"] },
  }),
  t("vertex-ai", "Vertex AI", "AI API", {
    pypi: ["google-cloud-aiplatform"],
    imports: { pypi: ["google.cloud.aiplatform", "vertexai"] },
  }),
  t("cloud-translation", "Cloud Translation", "AI API", {
    pypi: ["google-cloud-translate"],
    imports: { pypi: ["google.cloud.translate"] },
  }),
  t("vercel-ai-sdk", "Vercel AI SDK", "AI API", { npm: ["ai", "@ai-sdk/*"] }),
  t("langchain", "LangChain", "AI API", {
    npm: ["langchain", "@langchain/*"],
    pypi: ["langchain", "langchain-*"],
  }),
  t("llamaindex", "LlamaIndex", "AI API", {
    npm: ["llamaindex"],
    pypi: ["llama-index", "llama-index-*"],
    imports: { pypi: ["llama_index"] },
  }),
  t("ollama", "Ollama", "AI API", { npm: ["ollama"], pypi: ["ollama"], images: ["ollama/ollama"] }),
  t("mcp", "Model Context Protocol", "AI API", {
    npm: ["@modelcontextprotocol/sdk"],
    pypi: ["mcp", "fastmcp"],
  }),
  // Databases and storage
  t("postgresql", "PostgreSQL", "database", {
    npm: ["pg", "postgres", "pg-promise"],
    pypi: ["psycopg2", "psycopg2-binary", "psycopg", "psycopg-binary", "asyncpg"],
    crates: ["postgres", "tokio-postgres"],
    go: ["github.com/jackc/pgx*", "github.com/lib/pq"],
    images: ["postgres", "postgis/postgis", "pgvector/pgvector", "bitnami/postgresql"],
  }),
  t("mysql", "MySQL", "database", {
    npm: ["mysql", "mysql2"],
    pypi: ["mysqlclient", "pymysql", "mysql-connector-python"],
    go: ["github.com/go-sql-driver/mysql"],
    images: ["mysql"],
    imports: { pypi: ["MySQLdb", "mysql.connector"] },
  }),
  t("mariadb", "MariaDB", "database", { npm: ["mariadb"], images: ["mariadb"] }),
  t("sqlite", "SQLite", "database", {
    npm: ["better-sqlite3", "sqlite3", "sqlite"],
    pypi: ["aiosqlite"],
    crates: ["rusqlite"],
    go: ["github.com/mattn/go-sqlite3"],
    imports: { pypi: ["sqlite3"] },
  }),
  t("redis", "Redis", "database", {
    npm: ["redis", "ioredis"],
    pypi: ["redis"],
    crates: ["redis"],
    go: ["github.com/redis/go-redis*"],
    images: ["redis", "bitnami/redis", "redis/redis-stack"],
  }),
  t("mongodb", "MongoDB", "database", {
    npm: ["mongodb"],
    pypi: ["pymongo", "motor"],
    crates: ["mongodb"],
    go: ["go.mongodb.org/mongo-driver*"],
    images: ["mongo"],
  }),
  t("mongoose", "Mongoose", "database", { npm: ["mongoose"] }),
  t("elasticsearch", "Elasticsearch", "database", {
    npm: ["@elastic/elasticsearch"],
    pypi: ["elasticsearch"],
    images: ["elasticsearch"],
  }),
  t("neo4j", "Neo4j", "database", { npm: ["neo4j-driver"], pypi: ["neo4j"], images: ["neo4j"] }),
  t("clickhouse", "ClickHouse", "database", {
    pypi: ["clickhouse-connect"],
    images: ["clickhouse/clickhouse-server"],
  }),
  t("duckdb", "DuckDB", "database", { npm: ["duckdb", "@duckdb/*"], pypi: ["duckdb"] }),
  t("qdrant", "Qdrant", "database", {
    npm: ["@qdrant/js-client-rest"],
    pypi: ["qdrant-client"],
    images: ["qdrant/qdrant"],
  }),
  t("chroma", "Chroma", "database", {
    npm: ["chromadb"],
    pypi: ["chromadb"],
    images: ["chromadb/chroma"],
  }),
  t("pinecone", "Pinecone", "database", {
    npm: ["@pinecone-database/pinecone"],
    pypi: ["pinecone", "pinecone-client"],
  }),
  t("pgvector", "pgvector", "database", { npm: ["pgvector"], pypi: ["pgvector"] }),
  t("memcached", "Memcached", "database", { images: ["memcached"] }),
  t("supabase", "Supabase", "database", { npm: ["@supabase/*"], pypi: ["supabase"] }),
  t("prisma", "Prisma", "database", { npm: ["prisma", "@prisma/client"] }),
  t("drizzle", "Drizzle ORM", "database", { npm: ["drizzle-orm", "drizzle-kit"] }),
  t("typeorm", "TypeORM", "database", { npm: ["typeorm"] }),
  t("sequelize", "Sequelize", "database", { npm: ["sequelize"] }),
  t("sqlalchemy", "SQLAlchemy", "database", { pypi: ["sqlalchemy", "flask-sqlalchemy"] }),
  t("sqlmodel", "SQLModel", "database", { pypi: ["sqlmodel"] }),
  t("alembic", "Alembic", "database", { pypi: ["alembic"] }),
  t("diesel", "Diesel", "database", { crates: ["diesel"] }),
  t("sqlx", "SQLx", "database", { crates: ["sqlx"] }),
  t("sea-orm", "SeaORM", "database", { crates: ["sea-orm"] }),
  t("gorm", "GORM", "database", { go: ["gorm.io/gorm"] }),
  // Rust
  t("serde", "Serde", "data", { crates: ["serde", "serde_json", "serde_yaml", "serde_derive"] }),
  t("tokio", "Tokio", "other", { crates: ["tokio"] }),
  t("axum", "Axum", "web framework", { crates: ["axum"] }),
  t("actix-web", "Actix Web", "web framework", { crates: ["actix-web"] }),
  t("rocket", "Rocket", "web framework", { crates: ["rocket"] }),
  t("leptos", "Leptos", "web framework", { crates: ["leptos"] }),
  t("yew", "Yew", "UI library", { crates: ["yew"] }),
  t("egui", "egui", "UI library", { crates: ["egui", "eframe"] }),
  t("reqwest", "reqwest", "other", { crates: ["reqwest"] }),
  t("rayon", "Rayon", "other", { crates: ["rayon"] }),
  t("clap", "clap", "CLI", { crates: ["clap"] }),
  t("ratatui", "Ratatui", "CLI", { crates: ["ratatui"] }),
  t("ndarray", "ndarray", "data", { crates: ["ndarray"] }),
  t("pyo3", "PyO3", "other", { crates: ["pyo3"] }),
  t("grpc", "gRPC", "other", {
    npm: ["@grpc/grpc-js"],
    pypi: ["grpcio"],
    crates: ["tonic"],
    go: ["google.golang.org/grpc"],
    imports: { pypi: ["grpc"] },
  }),
  t("tree-sitter", "Tree-sitter", "other", {
    npm: ["web-tree-sitter", "tree-sitter", "tree-sitter-*"],
    pypi: ["tree-sitter", "tree-sitter-*"],
    crates: ["tree-sitter", "tree-sitter-*"],
  }),
  // Go
  t("gin", "Gin", "web framework", { go: ["github.com/gin-gonic/gin"] }),
  t("echo", "Echo", "web framework", { go: ["github.com/labstack/echo*"] }),
  t("fiber", "Fiber", "web framework", { go: ["github.com/gofiber/fiber*"] }),
  t("chi", "chi", "web framework", { go: ["github.com/go-chi/chi*"] }),
  t("cobra", "Cobra", "CLI", { go: ["github.com/spf13/cobra"] }),
  // Infrastructure and services
  t("docker", "Docker", "infrastructure", {
    paths: [/(?:^|\/)Dockerfile[^/]*$/, /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/],
  }),
  t("github-actions", "GitHub Actions", "infrastructure", {
    paths: [/^\.github\/workflows\/[^/]+\.ya?ml$/],
  }),
  t("gitlab-ci", "GitLab CI", "infrastructure", { paths: [/^\.gitlab-ci\.yml$/] }),
  t("circleci", "CircleCI", "infrastructure", { paths: [/^\.circleci\/config\.ya?ml$/] }),
  t("fly-io", "Fly.io", "infrastructure", { paths: [file("fly.toml")] }),
  t("vercel", "Vercel", "infrastructure", {
    npm: ["vercel", "@vercel/*"],
    paths: [file("vercel.json")],
  }),
  t("netlify", "Netlify", "infrastructure", {
    npm: ["netlify-cli", "@netlify/*"],
    paths: [file("netlify.toml")],
  }),
  t("render", "Render", "infrastructure", { paths: [/^render\.ya?ml$/] }),
  t("railway", "Railway", "infrastructure", {
    paths: [file("railway.json"), file("railway.toml")],
  }),
  t("cloudflare-workers", "Cloudflare Workers", "infrastructure", {
    npm: ["wrangler", "@cloudflare/*"],
    paths: [file("wrangler.toml"), file("wrangler.json"), file("wrangler.jsonc")],
  }),
  t("firebase", "Firebase", "infrastructure", {
    npm: ["firebase", "firebase-admin", "firebase-tools"],
    pypi: ["firebase-admin"],
    paths: [file("firebase.json")],
  }),
  t("terraform", "Terraform", "infrastructure", { paths: [/\.tf$/] }),
  t("pulumi", "Pulumi", "infrastructure", {
    npm: ["@pulumi/*"],
    pypi: ["pulumi", "pulumi-*"],
    paths: [/(?:^|\/)Pulumi\.ya?ml$/],
  }),
  t("helm", "Helm", "infrastructure", { paths: [file("Chart.yaml")] }),
  t("serverless", "Serverless Framework", "infrastructure", {
    npm: ["serverless"],
    paths: [file("serverless.yml"), file("serverless.yaml")],
  }),
  t("aws-cdk", "AWS CDK", "infrastructure", {
    npm: ["aws-cdk", "aws-cdk-lib", "aws-cdk-local"],
    pypi: ["aws-cdk-lib"],
    paths: [file("cdk.json")],
  }),
  t("aws-sdk", "AWS SDK", "infrastructure", {
    npm: ["aws-sdk", "@aws-sdk/*"],
    pypi: ["boto3", "botocore", "aioboto3"],
    crates: ["aws-sdk-*", "aws-config"],
  }),
  t("google-cloud-storage", "Cloud Storage", "infrastructure", {
    pypi: ["google-cloud-storage"],
    npm: ["@google-cloud/storage"],
    imports: { pypi: ["google.cloud.storage"] },
  }),
  t("localstack", "LocalStack", "infrastructure", {
    pypi: ["localstack"],
    images: ["localstack/localstack"],
  }),
  t("nginx", "nginx", "infrastructure", { images: ["nginx"], paths: [file("nginx.conf")] }),
  t("caddy", "Caddy", "infrastructure", { images: ["caddy"], paths: [file("Caddyfile")] }),
  t("kafka", "Apache Kafka", "infrastructure", {
    npm: ["kafkajs"],
    pypi: ["kafka-python", "confluent-kafka"],
    crates: ["rdkafka"],
    images: ["confluentinc/cp-kafka", "bitnami/kafka", "apache/kafka"],
  }),
  t("rabbitmq", "RabbitMQ", "infrastructure", {
    npm: ["amqplib"],
    pypi: ["pika", "aio-pika"],
    crates: ["lapin"],
    images: ["rabbitmq"],
  }),
  t("minio", "MinIO", "infrastructure", {
    npm: ["minio"],
    pypi: ["minio"],
    images: ["minio/minio"],
  }),
  t("prometheus", "Prometheus", "infrastructure", {
    npm: ["prom-client"],
    pypi: ["prometheus-client"],
    images: ["prom/prometheus"],
  }),
  t("grafana", "Grafana", "infrastructure", { images: ["grafana/grafana"] }),
  t("vagrant", "Vagrant", "infrastructure", { paths: [file("Vagrantfile")] }),
  t("nix", "Nix", "infrastructure", { paths: [/^flake\.nix$/, /^shell\.nix$/] }),
];

const BY_ID = new Map(TECHNOLOGIES.map((tech) => [tech.id, tech]));

/** The entry with `id`; undefined once the table no longer has it. */
export function technologyById(id: string): Technology | undefined {
  return BY_ID.get(id);
}

/** A package name as its ecosystem compares it: PEP 503 for PyPI, `-` and `_` equal for crates. */
export function normalizedName(ecosystem: Ecosystem, name: string): string {
  const lower = name.trim().toLowerCase();
  if (ecosystem === "pypi") return lower.replace(/[-_.]+/g, "-");
  if (ecosystem === "crates") return lower.replace(/_/g, "-");
  return lower;
}

/** Whether a table name (`react`, or a prefix pattern `@radix-ui/*`) matches a normalised name. */
export function packageMatches(pattern: string, name: string): boolean {
  if (!pattern.endsWith("*")) return pattern === name;
  const prefix = pattern.slice(0, -1);
  return name.length > prefix.length && name.startsWith(prefix);
}

/** The entry that declares `name` in `ecosystem`, or null. */
export function technologyForPackage(ecosystem: Ecosystem, name: string): Technology | null {
  const wanted = normalizedName(ecosystem, name);
  return (
    TECHNOLOGIES.find((tech) =>
      (tech.packages[ecosystem] ?? []).some((p) =>
        packageMatches(normalizedName(ecosystem, p), wanted),
      ),
    ) ?? null
  );
}

const TOOL_KINDS: ReadonlySet<TechnologyKind> = new Set([
  "testing",
  "build tool",
  "infrastructure",
]);

/** A build, test or infrastructure tool: never imported, so its declaration or file is enough. */
export const isTool = (tech: Technology) => tech.tool === true || TOOL_KINDS.has(tech.kind);

/** A kind as a table cell: "Web framework", "UI library", "AI API". */
export const kindLabel = (kind: TechnologyKind) =>
  `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
