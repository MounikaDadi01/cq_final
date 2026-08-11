/** @type {import('next').NextConfig} */
export default {
  // The repo's .env lives one level up, so the values are read explicitly in
  // server code rather than relying on Next's cwd-based loading.
  reactStrictMode: true,
}
