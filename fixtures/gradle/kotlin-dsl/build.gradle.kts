plugins {
    kotlin("jvm") version "1.9.0"
}

val jacksonVersion = "2.9.8"

dependencies {
    implementation("org.apache.logging.log4j:log4j-core:2.14.1")
    implementation("com.fasterxml.jackson.core:jackson-databind:$jacksonVersion")
    implementation(platform("org.springframework.boot:spring-boot-dependencies:2.5.0"))
    implementation(libs.commons.text)
    testImplementation("junit:junit:4.12")
}
