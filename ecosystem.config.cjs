module.exports = {
  apps: [
    {
      name: '9r-api',
      cwd: process.env.HOME + '/Documents/personal/github/9router-api',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '20127',
        NINEROUTER_HOME: '/Users/pid-alvian/Documents/personal/github/9router',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: process.env.HOME + '/.9router/9r-api-out.log',
      error_file: process.env.HOME + '/.9router/9r-api-error.log',
    },
  ],
};
