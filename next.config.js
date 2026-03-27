/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: '/dashboard', destination: '/dashboard.html' },
      { source: '/onboarding', destination: '/onboarding.html' },
      { source: '/signup', destination: '/signup.html' },
      { source: '/signin', destination: '/signin.html' },
      { source: '/upgrade', destination: '/upgrade.html' },
      { source: '/gives-back', destination: '/gives-back.html' },
      { source: '/admin-dashboard', destination: '/admin-dashboard.html' },
      { source: '/events', destination: '/events.html' },
      { source: '/partner-restaurant', destination: '/partner-restaurant.html' },
      { source: '/partner-signup', destination: '/partner-signup.html' },
      { source: '/disclaimer', destination: '/disclaimer.html' },
      { source: '/refund', destination: '/refund.html' },
      { source: '/gives-back', destination: '/gives-back.html' }
    ]
  }
}
module.exports = nextConfig
