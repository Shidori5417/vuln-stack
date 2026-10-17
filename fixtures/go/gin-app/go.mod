module github.com/acme/gin-app

go 1.20

toolchain go1.20.1

require (
	github.com/gin-gonic/gin v1.6.0
	golang.org/x/text v0.3.7 // indirect
	gopkg.in/yaml.v2 v2.2.8 // indirect
	example.com/local v0.0.0-00010101000000-000000000000
)

require github.com/dgrijalva/jwt-go v3.2.0+incompatible

replace example.com/local => ../local

replace gopkg.in/yaml.v2 v2.2.8 => gopkg.in/yaml.v2 v2.4.0
