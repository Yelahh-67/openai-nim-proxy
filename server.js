// server.js - OpenAI to NVIDIA NIM API Proxy (CRASH-PROOF VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true; 
const ENABLE_THINKING_MODE = true; 

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4-turbo': 'moonshotai/kimi-k2.5',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'z-ai/glm5',
  'claude-3-sonnet': 'z-ai/glm4.7',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    let nimModel = MODEL_MAPPING[model] || model;
    
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: ENABLE_THINKING_MODE ? { 
        chat_template_kwargs: { enable_thinking: true } 
      } : undefined,
      stream: stream || false
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
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (let line of lines) {
          if (line.trim() === '') continue;
          if (line.includes('[DONE]')) {
            res.write('data: [DONE]\n\n');
            continue;
          }
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta) {
              const delta = data.choices[0].delta;
              
              if (SHOW_REASONING) {
                let combinedContent = '';
                // Logika transform reasoning ke content agar UI tidak bingung
                if (delta.reasoning_content && !reasoningStarted) {
                  combinedContent = '<think>\n' + delta.reasoning_content;
                  reasoningStarted = true;
                } else if (delta.reasoning_content) {
                  combinedContent = delta.reasoning_content;
                } else if (delta.content && reasoningStarted) {
                  combinedContent = '\n</think>\n\n' + delta.content;
                  reasoningStarted = false;
                } else if (delta.content) {
                  combinedContent = delta.content;
                }

                if (combinedContent) {
                  delta.content = combinedContent;
                }
              }
              // Hapus property aslinya agar tidak konflik di OpenAI format
              delete delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            // Abaikan baris yang gagal parse, jangan biarkan server crash
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      // Logic non-stream (aman)
      const choice = response.data.choices[0];
      if (SHOW_REASONING && choice.message?.reasoning_content) {
        choice.message.content = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${choice.message.content}`;
        delete choice.message.reasoning_content;
      }
      res.json(response.data);
    }
    
  } catch (error) {
    console.error('Proxy Error:', error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({ error: error.message });
    }
  }
});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));
