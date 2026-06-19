# GuardianEye Server

WebSocket relay server for GuardianEye Parental Control system.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| PORT | Yes (auto) | Server port (Railway sets this automatically) |
| PAIR_CODE | Yes | Secret code to authenticate parent/child apps |
| SESSION_SECRET | Yes | Secret for session signing |
| NODE_ENV | No | Set to "production" for prod |

## WebSocket Path

`wss://your-domain.railway.app/api/ws`

## QR Format (for child app)

`wss://your-domain.railway.app/api/ws|YOUR_PAIR_CODE`
