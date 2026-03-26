// server.js - OpenAI to NVIDIA NIM Proxy (AUTO-RETRY VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

const MODEL_MAPPING = {
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-sonnet': 'z-ai/glm4.7', 
  'gemini-pro': 'z-ai/glm5'
};

app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, temperature, max_tokens, stream } = req.body;
  let nimModel = MODEL_MAPPING[model] || model;
  const isGLM = nimModel.toLowerCase().includes('glm');

  // Fungsi untuk bina request body
  const buildBody = (attempt) => {
    const body = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };

    if (ENABLE_THINKING_MODE && isGLM) {
      if (attempt === 1) {
        // Cuba cara standard vLLM
        body.extra_body = { chat_template_kwargs: { enable_thinking: true } };
      } else if (attempt === 2) {
        // Jika gagal, cuba cara alternatif (langsung)
        body.extra_body = { thinking: true };
      }
    }
    return body;
  };

  async function makeRequest(attempt = 1) {
    try {
      const nimRequest = buildBody(attempt);
      
      const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      });

      // Jika berjaya, terus hantar ke user
      if (stream) {
        handleStream(response, res);
      } else {
        handleJSON(response, res);
      }

    } catch (error) {
      // Jika Attempt 1 kena Error 400, cuba Attempt 2
      if (attempt === 1 && error.response?.status === 400 && isGLM) {
        console.log("Attempt 1 failed (400), trying Attempt 2...");
        return makeRequest(2);
      }
      
      // Jika semua gagal, hantar ralat
      console.error('Final Proxy Error:', error.message);
      if (!res.headersSent) {
        res.status(error.response?.status || 500).json({ error: error.message });
      }
    }
  }

  makeRequest(1);
});

// --- HELPER FUNCTIONS (ELAK CRASH) ---

function handleStream(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  let unfinishedLine = '';
  let reasoningStarted = false;

  response.data.on('data', (chunk) => {
    const lines = (unfinishedLine + chunk.toString()).split('\n');
    unfinishedLine = lines.pop();

    for (let line of lines) {
      let trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      if (trimmed.includes('[DONE]')) {
        res.write('data: [DONE]\n\n');
        continue;
      }

      try {
        const data = JSON.parse(trimmed.slice(6));
        if (data.choices?.[0]?.delta && SHOW_REASONING) {
          const delta = data.choices[0].delta;
          if (delta.reasoning_content) {
            if (!reasoningStarted) {
              delta.content = '<think>\n' + delta.reasoning_content;
              reasoningStarted = true;
            } else {
              delta.content = delta.reasoning_content;
            }
          } else if (delta.content && reasoningStarted) {
            delta.content = '\n</think>\n\n' + delta.content;
            reasoningStarted = false;
          }
          delete delta.reasoning_content;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {}
    }
  });
  response.data.on('end', () => res.end());
}

function handleJSON(response, res) {
  let data = response.data;
  if (SHOW_REASONING && data.choices?.[0]?.message?.reasoning_content) {
    const msg = data.choices[0].message;
    msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content}`;
    delete msg.reasoning_content;
  }
  res.json(data);
}

app.listen(PORT, () => console.log(`Server is running on ${PORT}`));
