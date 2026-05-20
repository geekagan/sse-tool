import http from 'http'

const PORT = 4399

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let count = 0
    const interval = setInterval(() => {
      count++
      res.write(`id: ${count}\ndata: message-${count}\n\n`)
      if (count >= 3) { clearInterval(interval); res.end() }
    }, 50)
    req.on('close', () => clearInterval(interval))

  } else if (url.pathname === '/sse-drop') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write('data: before-drop\n\n')
    setTimeout(() => res.destroy(), 50)

  } else if (url.pathname === '/sse-401') {
    res.writeHead(401); res.end()

  } else if (url.pathname === '/sse-429') {
    res.writeHead(429, { 'Retry-After': '1' }); res.end()

  } else {
    res.writeHead(404); res.end()
  }
})

server.listen(PORT, () => {
  process.stdout.write(`E2E server listening on http://localhost:${PORT}\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
