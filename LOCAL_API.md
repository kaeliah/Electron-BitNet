# Local API

Electron BitNet can expose the bundled local model through an OpenAI-compatible HTTP API.

Internal model server:

`http://127.0.0.1:5272`

CORS-open proxy for browser/web apps:

`http://127.0.0.1:5273`

Recommended endpoint for web apps:

`POST /v1/chat/completions`

Recommended base URL:

`http://127.0.0.1:5273`

Internal main endpoint:

`POST /v1/chat/completions`

Health check:

`GET /health`

List models:

`GET /v1/models`

Authentication:

For direct calls to `5272`, use the API key stored in:

`%APPDATA%\ElectronBitnet\local-api.json`

For browser/web-app calls to `5273`, authentication is not required.
This proxy only listens on `127.0.0.1`, adds CORS headers, and forwards requests to the internal authenticated model server.

PowerShell example:

```powershell
$headers = @{
  "Content-Type" = "application/json"
  "Authorization" = "Bearer YOUR_API_KEY"
}

$body = @{
  model = "bitnet-local"
  messages = @(
    @{ role = "system"; content = "You are a helpful assistant." },
    @{ role = "user"; content = "Merhaba" }
  )
  temperature = 0.7
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:5272/v1/chat/completions" `
  -Headers $headers `
  -Body $body
```

Browser `fetch` example:

```js
const response = await fetch("http://127.0.0.1:5273/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "bitnet-local",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Build me an API client." }
    ],
    temperature: 0.7
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

OpenAI SDK-style example:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "not-needed-for-5273",
  baseURL: "http://127.0.0.1:5273/v1",
  dangerouslyAllowBrowser: true
});

const completion = await client.chat.completions.create({
  model: "bitnet-local",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Merhaba" }
  ],
  temperature: 0.7
});

console.log(completion.choices[0].message.content);
```
