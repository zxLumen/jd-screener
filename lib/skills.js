/**
 * 技能词典：求职 JD / 简历里最常见的硬技能与软技能。
 * 只做「命中」，不做语义推断——语义交给 AI 层，规则层保持可解释。
 */
import { hasAlias } from './text.js'

export const SKILLS = [
  // ---------- 编程语言 ----------
  { id: 'python', name: 'Python', aliases: ['python', 'py3'] },
  { id: 'java', name: 'Java', aliases: ['java'] },
  { id: 'go', name: 'Go', aliases: ['golang', 'go语言', 'go'] },
  { id: 'cpp', name: 'C++', aliases: ['c++', 'cpp'] },
  { id: 'c', name: 'C', aliases: ['c语言'] },
  { id: 'rust', name: 'Rust', aliases: ['rust'] },
  { id: 'typescript', name: 'TypeScript', aliases: ['typescript', 'ts'] },
  { id: 'javascript', name: 'JavaScript', aliases: ['javascript', 'js'] },
  { id: 'php', name: 'PHP', aliases: ['php'] },
  { id: 'scala', name: 'Scala', aliases: ['scala'] },
  { id: 'kotlin', name: 'Kotlin', aliases: ['kotlin'] },
  { id: 'swift', name: 'Swift', aliases: ['swift'] },
  { id: 'sql', name: 'SQL', aliases: ['sql'] },
  { id: 'shell', name: 'Shell', aliases: ['shell', 'bash'] },
  { id: 'r', name: 'R', aliases: ['r语言'] },
  { id: 'matlab', name: 'MATLAB', aliases: ['matlab'] },
  { id: 'lua', name: 'Lua', aliases: ['lua'] },

  // ---------- 后端 / 中间件 ----------
  { id: 'fastapi', name: 'FastAPI', aliases: ['fastapi'] },
  { id: 'django', name: 'Django', aliases: ['django'] },
  { id: 'flask', name: 'Flask', aliases: ['flask'] },
  { id: 'spring', name: 'Spring', aliases: ['spring boot', 'springboot', 'spring'] },
  { id: 'gin', name: 'Gin', aliases: ['gin框架', 'gin'] },
  { id: 'nodejs', name: 'Node.js', aliases: ['node.js', 'nodejs', 'node'] },
  { id: 'express', name: 'Express', aliases: ['express'] },
  { id: 'grpc', name: 'gRPC', aliases: ['grpc'] },
  { id: 'rest', name: 'REST/API', aliases: ['restful', 'rest api', 'api设计', 'api 设计'] },
  { id: 'graphql', name: 'GraphQL', aliases: ['graphql'] },
  { id: 'microservice', name: '微服务', aliases: ['微服务', 'microservice', 'microservices'] },
  { id: 'distributed', name: '分布式系统', aliases: ['分布式', 'distributed system'] },
  { id: 'mq', name: '消息队列', aliases: ['消息队列', 'message queue', 'mq'] },
  { id: 'kafka', name: 'Kafka', aliases: ['kafka'] },
  { id: 'rabbitmq', name: 'RabbitMQ', aliases: ['rabbitmq'] },
  { id: 'redis', name: 'Redis', aliases: ['redis'] },
  { id: 'mysql', name: 'MySQL', aliases: ['mysql'] },
  { id: 'postgres', name: 'PostgreSQL', aliases: ['postgresql', 'postgres', 'pg'] },
  { id: 'mongodb', name: 'MongoDB', aliases: ['mongodb', 'mongo'] },
  { id: 'elasticsearch', name: 'Elasticsearch', aliases: ['elasticsearch', 'elastic search', 'es搜索'] },
  { id: 'clickhouse', name: 'ClickHouse', aliases: ['clickhouse'] },
  { id: 'hive', name: 'Hive', aliases: ['hive'] },
  { id: 'spark', name: 'Spark', aliases: ['spark'] },
  { id: 'flink', name: 'Flink', aliases: ['flink'] },
  { id: 'hadoop', name: 'Hadoop', aliases: ['hadoop'] },
  { id: 'ray', name: 'Ray', aliases: ['ray serve', 'ray'] },
  { id: 'airflow', name: 'Airflow', aliases: ['airflow'] },
  { id: 'celery', name: 'Celery', aliases: ['celery'] },
  { id: 'nginx', name: 'Nginx', aliases: ['nginx'] },
  { id: 'websocket', name: 'WebSocket', aliases: ['websocket', 'web socket'] },
  { id: 'network', name: '网络协议', aliases: ['tcp/ip', 'tcp', 'http协议', '网络协议'] },
  { id: 'linux', name: 'Linux', aliases: ['linux', 'unix'] },
  { id: 'git', name: 'Git', aliases: ['git', 'github', 'gitlab'] },
  { id: 'testing', name: '测试', aliases: ['自动化测试', '单元测试', 'qa', '测试'] },
  { id: 'security', name: '安全', aliases: ['信息安全', '网络安全', 'security'] },

  // ---------- 云原生 / 运维 ----------
  { id: 'docker', name: 'Docker', aliases: ['docker', '容器化'] },
  { id: 'kubernetes', name: 'Kubernetes', aliases: ['kubernetes', 'k8s'] },
  { id: 'helm', name: 'Helm', aliases: ['helm'] },
  { id: 'terraform', name: 'Terraform', aliases: ['terraform'] },
  { id: 'ansible', name: 'Ansible', aliases: ['ansible'] },
  { id: 'aws', name: 'AWS', aliases: ['aws', 'amazon web services'] },
  { id: 'gcp', name: 'GCP', aliases: ['gcp', 'google cloud'] },
  { id: 'azure', name: 'Azure', aliases: ['azure'] },
  { id: 'aliyun', name: '阿里云', aliases: ['阿里云', 'aliyun'] },
  { id: 'cicd', name: 'CI/CD', aliases: ['ci/cd', 'cicd', '持续集成', '持续交付'] },
  { id: 'jenkins', name: 'Jenkins', aliases: ['jenkins'] },
  { id: 'gha', name: 'GitHub Actions', aliases: ['github actions'] },
  { id: 'prometheus', name: 'Prometheus', aliases: ['prometheus'] },
  { id: 'grafana', name: 'Grafana', aliases: ['grafana'] },
  { id: 'observability', name: '可观测性', aliases: ['可观测', '监控体系', 'monitoring'] },
  { id: 'otel', name: 'OpenTelemetry', aliases: ['opentelemetry', 'otel'] },
  { id: 'serverless', name: 'Serverless', aliases: ['serverless', '函数计算'] },
  { id: 'caddy', name: 'Caddy', aliases: ['caddy'] },

  // ---------- AI / 数据 ----------
  { id: 'ml', name: '机器学习', aliases: ['机器学习', 'machine learning', 'ml'] },
  { id: 'dl', name: '深度学习', aliases: ['深度学习', 'deep learning'] },
  { id: 'llm', name: '大模型', aliases: ['大模型', '大语言模型', 'llm'] },
  { id: 'rag', name: 'RAG', aliases: ['rag', '检索增强', 'retrieval augmented'] },
  { id: 'agent', name: 'Agent', aliases: ['ai agent', '智能体', 'agent'] },
  { id: 'langchain', name: 'LangChain', aliases: ['langchain'] },
  { id: 'langgraph', name: 'LangGraph', aliases: ['langgraph'] },
  { id: 'prompt', name: 'Prompt 工程', aliases: ['prompt engineering', '提示词', 'prompt'] },
  { id: 'finetune', name: '微调', aliases: ['微调', 'fine-tune', 'finetune', 'lora', 'sft'] },
  { id: 'pytorch', name: 'PyTorch', aliases: ['pytorch', 'torch'] },
  { id: 'tensorflow', name: 'TensorFlow', aliases: ['tensorflow', 'tf'] },
  { id: 'transformers', name: 'Transformers', aliases: ['transformers'] },
  { id: 'embedding', name: 'Embedding', aliases: ['embedding', '向量检索', '向量化'] },
  { id: 'vectordb', name: '向量数据库', aliases: ['向量数据库', 'milvus', 'faiss', 'qdrant', 'pinecone', 'pgvector'] },
  { id: 'inference', name: '推理加速', aliases: ['推理加速', '推理优化', 'vllm', 'tensorrt', '量化'] },
  { id: 'multimodal', name: '多模态', aliases: ['多模态', 'multimodal'] },
  { id: 'cv', name: '计算机视觉', aliases: ['计算机视觉', 'computer vision', 'opencv'] },
  { id: 'nlp', name: 'NLP', aliases: ['自然语言处理', 'nlp'] },
  { id: 'asr', name: '语音识别', aliases: ['语音识别', 'asr', 'whisper'] },
  { id: 'tts', name: '语音合成', aliases: ['语音合成', 'tts'] },
  { id: 'recsys', name: '推荐系统', aliases: ['推荐系统', '推荐算法', 'recommendation'] },
  { id: 'mlops', name: 'MLOps', aliases: ['mlops', '机器学习平台', '模型平台'] },
  { id: 'kubeflow', name: 'Kubeflow', aliases: ['kubeflow'] },
  { id: 'wandb', name: 'W&B', aliases: ['wandb', 'weights & biases'] },
  { id: 'openai', name: 'OpenAI', aliases: ['openai', 'gpt-4', 'gpt4', 'chatgpt'] },
  { id: 'huggingface', name: 'HuggingFace', aliases: ['huggingface', 'hugging face'] },
  { id: 'data-analysis', name: '数据分析', aliases: ['数据分析', 'data analysis'] },
  { id: 'abtest', name: 'A/B 测试', aliases: ['a/b test', 'ab test', 'ab测试', 'a/b测试'] },
  { id: 'warehouse', name: '数据仓库', aliases: ['数据仓库', '数仓', 'data warehouse'] },
  { id: 'etl', name: 'ETL', aliases: ['etl', '数据清洗'] },
  { id: 'bi', name: 'BI', aliases: ['tableau', 'superset', '商业智能'] },
  { id: 'statistics', name: '统计学', aliases: ['统计学', 'statistics'] },
  { id: 'pandas', name: 'Pandas', aliases: ['pandas'] },
  { id: 'numpy', name: 'NumPy', aliases: ['numpy'] },
  { id: 'excel', name: 'Excel', aliases: ['excel'] },

  // ---------- 前端 / 移动端 ----------
  { id: 'react', name: 'React', aliases: ['react'] },
  { id: 'vue', name: 'Vue', aliases: ['vue'] },
  { id: 'nextjs', name: 'Next.js', aliases: ['next.js', 'nextjs'] },
  { id: 'vite', name: 'Vite', aliases: ['vite'] },
  { id: 'webpack', name: 'Webpack', aliases: ['webpack'] },
  { id: 'tailwind', name: 'Tailwind', aliases: ['tailwind'] },
  { id: 'html', name: 'HTML', aliases: ['html5', 'html'] },
  { id: 'css', name: 'CSS', aliases: ['css3', 'css'] },
  { id: 'redux', name: 'Redux', aliases: ['redux'] },
  { id: 'threejs', name: 'Three.js', aliases: ['three.js', 'threejs'] },
  { id: 'webgl', name: 'WebGL', aliases: ['webgl'] },
  { id: 'canvas', name: 'Canvas', aliases: ['canvas'] },
  { id: 'miniprogram', name: '小程序', aliases: ['小程序', 'mini program'] },
  { id: 'uniapp', name: 'uni-app', aliases: ['uniapp', 'uni-app'] },
  { id: 'flutter', name: 'Flutter', aliases: ['flutter'] },
  { id: 'reactnative', name: 'React Native', aliases: ['react native', 'rn'] },
  { id: 'ios', name: 'iOS', aliases: ['ios'] },
  { id: 'swiftui', name: 'SwiftUI', aliases: ['swiftui'] },
  { id: 'android', name: 'Android', aliases: ['android'] },
  { id: 'objc', name: 'Objective-C', aliases: ['objective-c', 'objc'] },
  { id: 'figma', name: 'Figma', aliases: ['figma'] },
  { id: 'ui', name: 'UI/交互', aliases: ['ui设计', '交互设计', '用户体验'] },

  // ---------- 产品 / 软技能 / 行业 ----------
  { id: 'product', name: '产品能力', aliases: ['产品设计', '产品经理', 'product manager'] },
  { id: 'pm', name: '项目管理', aliases: ['项目管理', 'pmp'] },
  { id: 'agile', name: '敏捷', aliases: ['敏捷', 'scrum'] },
  { id: 'user-research', name: '用户研究', aliases: ['用户研究', '用户调研'] },
  { id: 'growth', name: '增长', aliases: ['增长', 'growth'] },
  { id: 'operation', name: '运营', aliases: ['运营', 'operations'] },
  { id: 'seo', name: 'SEO', aliases: ['seo'] },
  { id: 'writing', name: '文案', aliases: ['文案', '写作'] },
  { id: 'english', name: '英语', aliases: ['英语', 'english'] },
  { id: 'communication', name: '沟通', aliases: ['沟通', 'communication'] },
  { id: 'teamwork', name: '团队协作', aliases: ['团队协作', '团队合作'] },
  { id: 'leadership', name: '带团队', aliases: ['带团队', '团队管理', 'leadership'] },
  { id: 'customer', name: '客户沟通', aliases: ['客户沟通', '客户成功'] },
  { id: 'domain', name: '行业经验', aliases: ['行业经验', '业务经验'] },
  { id: 'video', name: '视频', aliases: ['视频剪辑', '短视频'] },
  { id: 'design', name: '设计', aliases: ['平面设计', '视觉设计', 'design'] },
  { id: 'blockchain', name: '区块链', aliases: ['区块链', 'blockchain'] },
  { id: 'iot', name: '物联网', aliases: ['物联网', 'iot'] },
  { id: 'embedded', name: '嵌入式', aliases: ['嵌入式', '单片机', 'esp32'] },
  { id: 'hardware', name: '硬件', aliases: ['硬件', '电路'] },
]

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]))

export function skillName(id) {
  return BY_ID.get(id)?.name || id
}

/**
 * 从文本里识别技能。
 * @returns {Array<{id,name,weight,where}>}
 * 同一技能取最高权重（标题 3 / 任职要求 2 / 其他 1）。
 */
export function detectSkills(text, opts = {}) {
  const t = String(text || '')
  const title = String(opts.title || '')
  const found = new Map()

  const consider = (id, weight, where) => {
    const prev = found.get(id)
    if (!prev || weight > prev.weight) found.set(id, { weight, where })
  }

  for (const s of SKILLS) {
    for (const a of s.aliases) {
      if (!hasAlias(t, a)) continue
      let weight = 1
      let where = 'other'
      if (title && hasAlias(title, a)) {
        weight = 3
        where = 'title'
      } else if (opts.requirement && hasAlias(opts.requirement, a)) {
        weight = 2
        where = 'requirement'
      }
      consider(s.id, weight, where)
    }
  }

  return [...found.entries()]
    .map(([id, v]) => ({ id, name: skillName(id), weight: v.weight, where: v.where }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
}
