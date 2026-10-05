Pod::Spec.new do |s|
  s.name           = 'FsharePeer'
  s.version        = '1.0.0'
  s.summary        = 'fshare phone-to-phone over Wi-Fi'
  s.description    = s.summary
  s.author         = 'akdevv'
  s.homepage       = 'https://github.com/akdevv'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
