# AGENTS.md - bot-wa-marelta

## Run Commands
```bash
npm start           # Start bot (node index.js)
```

## Required Env Variables
- `GROQ_API_KEY` - GROQ API key for AI responses
- `PORT` - Express server port (default: 3000)

## Architecture
- **Entry**: `index.js` - Single-file WhatsApp bot using whatsapp-web.js
- **Auth**: LocalAuth stores session in `.wwebjs-auth/` directory
- **AI**: GROQ SDK with `llama-3.3-70b-versatile` model
- **Products**: Fetches from `https://marelta.com/productos/` API
- **Memory**: In-memory chat history per user (max 5 exchanges)

## Important Quirks
- **DEBUG_MODE**: Set `DEBUG_CONFIG.enabled = true` in index.js to log without sending messages
- **Number Filter**: Bot only responds to two hardcoded numbers (anthony: `280779343003800@lid`, ossuan: `77425526444166@lid`)
- **Platform**: Puppeteer args differ Windows vs Linux - code auto-detects via `process.platform`
- **QR Code**: Generated as `./qr.png`, served via Express at `GET /qr`
- **Session Persistence**: WhatsApp session persists across restarts via LocalAuth

## File Structure
```
index.js       # Main bot (409 lines)
.env         # Environment variables (GROQ_API_KEY, PORT)
package.json # Dependencies
```