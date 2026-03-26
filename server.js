// server.js - Versi GLM-4.7 Anti-Error 400
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 TOGGLE UTAMA
const SHOW_REASONING = true; 
const ENABLE_THINKING_MODE = true; 

const MODEL_MAPPING = {
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-sonnet': 'z-ai/glm4.7', 
  'gemini-pro': 'z-ai/glm5'
};

app.post('/v1/chat/completions', async (req, res) => {
  try {
    let { model, messages, temperature, max_tokens, stream } = req.body;
    let nimModel = MODEL_MAPPING[model] || model;
    const isGLM = nimModel.toLowerCase().includes('glm');

    // LOGIK ANTI-ERROR 400:
    // Jika Thinking Mode ON dan model adalah GLM, kita tak hantar parameter extra_body.
    // Sebaliknya, kita suruh dia berfikir secara manual dalam prompt.
    if (ENABLE_THINKING_MODE && isGLM) {
      const thinkingPrompt = "\n\n[SYSTEM INSTRUCTION: You must think deeply before answering. Start your response with <think> followed by your reasoning, then close it with </think> before giving the final answer.]";
      
      // Tambah arahan ke mesej terakhir user supaya model tak lupa
      if (messages.length > 0) {
        messages[messages.length - 1].content += thinkingPrompt;
      }
    }

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      stream: stream || false
      // KITA TAK LETAK extra_body DI SINI UNTUK GLM SUPAYA TAK ERROR 400
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      let unfinishedLine = '';

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
            // Kita hantar apa adanya sebab model akan tulis <think> secara manual dalam content
            res.write(`${trimmed}\n\n`);
          } catch (e) {}
        }
      });
      response.data.on('end', () => res.end());
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({ 
        error: { message: error.message || 'Server error' } 
      });
    }
  }
});

app.listen(PORT, () => console.log(`Proxy up on ${PORT} | Thinking: ${ENABLE_THINKING_MODE}`));
