import { Router, Request, Response } from 'express';

const router = Router();

const sdks = {
  python: {
    language: 'Python',
    install: 'pip install requests',
    quickstart: `import requests

BASE = "http://77.42.89.233:3001/api"
HEADERS = {"X-Agent-Id": "my-agent", "Content-Type": "application/json"}

# Provision a phone number
phone = requests.post(f"{BASE}/phone/provision", headers=HEADERS,
    json={"country": "US", "capabilities": ["sms", "voice"]}).json()
print(f"Got number: {phone['number']}")

# Send SMS
requests.post(f"{BASE}/phone/send-sms", headers=HEADERS,
    json={"from": phone["number"], "to": "+1234567890", "body": "Hello from my agent!"})

# Create email
email = requests.post(f"{BASE}/email/provision", headers=HEADERS,
    json={"username": "myagent", "domain": "palmyr.dev"}).json()

# Spin up compute
server = requests.post(f"{BASE}/compute/provision", headers=HEADERS,
    json={"type": "container", "image": "python:3.11", "resources": {"cpu": 1, "memory": "512MB"}}).json()`,
    wrapper_class: `class Palmyr:
    def __init__(self, agent_id, base_url="http://77.42.89.233:3001/api"):
        self.base = base_url
        self.headers = {"X-Agent-Id": agent_id, "Content-Type": "application/json"}

    def _post(self, path, data):
        import requests
        return requests.post(f"{self.base}{path}", headers=self.headers, json=data).json()

    def _get(self, path):
        import requests
        return requests.get(f"{self.base}{path}", headers=self.headers).json()

    def provision_phone(self, country="US"):
        return self._post("/phone/provision", {"country": country, "capabilities": ["sms", "voice"]})

    def send_sms(self, from_number, to, body):
        return self._post("/phone/send-sms", {"from": from_number, "to": to, "body": body})

    def provision_email(self, username, domain="palmyr.dev"):
        return self._post("/email/provision", {"username": username, "domain": domain})

    def provision_compute(self, image="python:3.11", cpu=1, memory="512MB"):
        return self._post("/compute/provision", {"type": "container", "image": image, "resources": {"cpu": cpu, "memory": memory}})

    def status(self):
        return self._get("/status")

# Usage:
# os = Palmyr("my-agent")
# phone = os.provision_phone()
# os.send_sms(phone["number"], "+1234567890", "Hello!")`
  },
  javascript: {
    language: 'JavaScript / Node.js',
    install: 'npm install node-fetch  # or use built-in fetch in Node 18+',
    quickstart: `const BASE = "http://77.42.89.233:3001/api";
const HEADERS = { "X-Agent-Id": "my-agent", "Content-Type": "application/json" };

async function main() {
  // Provision phone
  const phone = await fetch(\`\${BASE}/phone/provision\`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ country: "US", capabilities: ["sms", "voice"] })
  }).then(r => r.json());

  // Send SMS
  await fetch(\`\${BASE}/phone/send-sms\`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ from: phone.number, to: "+1234567890", body: "Hello!" })
  });

  // Provision email
  const email = await fetch(\`\${BASE}/email/provision\`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ username: "myagent", domain: "palmyr.dev" })
  }).then(r => r.json());

  console.log({ phone: phone.number, email: email.address });
}

main();`,
    wrapper_class: `class Palmyr {
  constructor(agentId, baseUrl = "http://77.42.89.233:3001/api") {
    this.base = baseUrl;
    this.headers = { "X-Agent-Id": agentId, "Content-Type": "application/json" };
  }

  async _post(path, data) {
    const res = await fetch(\`\${this.base}\${path}\`, {
      method: "POST", headers: this.headers, body: JSON.stringify(data)
    });
    return res.json();
  }

  async _get(path) {
    const res = await fetch(\`\${this.base}\${path}\`, { headers: this.headers });
    return res.json();
  }

  provisionPhone(country = "US") {
    return this._post("/phone/provision", { country, capabilities: ["sms", "voice"] });
  }

  sendSms(from, to, body) {
    return this._post("/phone/send-sms", { from, to, body });
  }

  provisionEmail(username, domain = "palmyr.dev") {
    return this._post("/email/provision", { username, domain });
  }

  provisionCompute(image = "python:3.11", cpu = 1, memory = "512MB") {
    return this._post("/compute/provision", { type: "container", image, resources: { cpu, memory } });
  }

  status() { return this._get("/status"); }
}

// Usage:
// const os = new Palmyr("my-agent");
// const phone = await os.provisionPhone();`
  },
  rust: {
    language: 'Rust',
    install: 'cargo add reqwest serde serde_json tokio --features reqwest/json,tokio/full',
    quickstart: `use reqwest::Client;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let base = "http://77.42.89.233:3001/api";

    let phone: serde_json::Value = client.post(format!("{base}/phone/provision"))
        .header("X-Agent-Id", "my-agent")
        .json(&json!({"country": "US", "capabilities": ["sms", "voice"]}))
        .send().await?.json().await?;

    println!("Phone: {}", phone["number"]);
    Ok(())
}`
  },
  curl: {
    language: 'cURL (any language)',
    install: 'Built into most systems',
    quickstart: `# Provision a phone number
curl -X POST http://77.42.89.233:3001/api/phone/provision \\
  -H "X-Agent-Id: my-agent" \\
  -H "Content-Type: application/json" \\
  -d '{"country": "US", "capabilities": ["sms", "voice"]}'

# Send SMS
curl -X POST http://77.42.89.233:3001/api/phone/send-sms \\
  -H "X-Agent-Id: my-agent" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "+1...", "to": "+1234567890", "body": "Hello!"}'

# Check status
curl http://77.42.89.233:3001/api/status -H "X-Agent-Id: my-agent"`
  }
};

// GET /api/sdk - list all SDKs
router.get('/', (_req: Request, res: Response) => {
  res.json({
    title: 'Palmyr SDK & Code Examples',
    description: 'Ready-to-use code snippets and wrapper classes for integrating with Palmyr',
    languages: Object.keys(sdks),
    note: 'All examples work in hackathon mode (FREE) — just use any X-Agent-Id header',
    docs: 'http://77.42.89.233:3001/docs',
    sdks
  });
});

// GET /api/sdk/:language
router.get('/:language', (req: Request, res: Response) => {
  const lang = (req.params.language as string).toLowerCase();
  const sdk = sdks[lang as keyof typeof sdks];
  if (!sdk) {
    return res.status(404).json({
      error: 'Language not found',
      available: Object.keys(sdks)
    });
  }
  res.json(sdk);
});

export default router;
