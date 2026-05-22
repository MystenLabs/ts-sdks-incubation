// swift-tools-version:5.9
import PackageDescription

let package = Package(
	name: "apple-signer",
	platforms: [
		.macOS(.v12),
	],
	targets: [
		.executableTarget(
			name: "apple-signer",
			path: "Sources/apple-signer"
		),
	]
)
