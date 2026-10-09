#!/usr/bin/env ruby
# One App Store Connect API request, signed with the repository's ASC key
# (ES256 JWT, no gems). Used by .github/workflows/asc-status.yml.
#   ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_P8 (key content) from the environment.
#   ruby asc-api.rb GET '/v1/apps/<id>/appStoreVersions?filter[platform]=MAC_OS'
#   ruby asc-api.rb PATCH '/v1/appStoreVersions/<id>' '{"data":{...}}'
require 'openssl'
require 'json'
require 'base64'
require 'net/http'
require 'uri'

key_id = ENV.fetch('ASC_API_KEY_ID')
issuer = ENV.fetch('ASC_API_ISSUER_ID')
key_pem = ENV.fetch('ASC_API_KEY_P8').strip
# The secret may hold the .p8 as base64 (as fastlane's is_key_content_base64) or with escaped newlines.
key_pem = key_pem.gsub('\\n', "\n")
key_pem = Base64.decode64(key_pem) unless key_pem.include?('-----BEGIN')
b64 = ->(s) { Base64.urlsafe_encode64(s, padding: false) }

now = Time.now.to_i
header = { alg: 'ES256', kid: key_id, typ: 'JWT' }.to_json
payload = { iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }.to_json
signing_input = "#{b64.call(header)}.#{b64.call(payload)}"
key = OpenSSL::PKey::EC.new(key_pem)
der = key.sign(OpenSSL::Digest.new('sha256'), signing_input)
r, s = OpenSSL::ASN1.decode(der).value.map { |i| i.value.to_s(2).rjust(32, "\0")[-32..] }
token = "#{signing_input}.#{b64.call(r + s)}"

method = (ARGV[0] || 'GET').upcase
path = ARGV[1] or abort 'path required'
body = ARGV[2]
abort 'write methods need CONFIRM_WRITE=yes' if method != 'GET' && ENV['CONFIRM_WRITE'] != 'yes'
uri = URI("https://api.appstoreconnect.apple.com#{path}")
req = Net::HTTP.const_get(method.capitalize).new(uri)
req['Authorization'] = "Bearer #{token}"
req['Content-Type'] = 'application/json'
req.body = body if body && !body.empty?
res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
puts "HTTP #{res.code}"
text = res.body.to_s
puts(text.empty? ? '(empty body)' : JSON.pretty_generate(JSON.parse(text)))
exit(res.code.to_i < 400 ? 0 : 1)
