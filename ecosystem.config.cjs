module.exports = {
  apps: [
    {
      name: 'is.am',
      script: './src/server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-sqlite',
      env: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '8',
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
    },
  ],
}
