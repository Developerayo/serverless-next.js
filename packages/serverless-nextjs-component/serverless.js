const { Component } = require("@serverless/core");
const nextBuild = require("next/dist/build").default;
const fse = require("fs-extra");
const path = require("path");
const url = require("url");
const isDynamicRoute = require("./lib/isDynamicRoute");
const expressifyDynamicRoute = require("./lib/expressifyDynamicRoute");
const pathToRegexStr = require("./lib/pathToRegexStr");
const {
  SSR_LAMBDA_BUILD_DIR,
  LAMBDA_AT_EDGE_BUILD_DIR
} = require("./constants");

class NextjsComponent extends Component {
  async default(inputs = {}) {
    return this.build();
  }

  readPublicFiles() {
    return fse.readdir("./public");
  }

  readPagesManifest() {
    return fse.readJSON("./.next/serverless/pages-manifest.json");
  }

  // do not confuse the component build manifest with nextjs pages manifest!
  // they have different formats and data
  getBlankBuildManifest() {
    return {
      pages: {
        ssr: {
          dynamic: {},
          nonDynamic: {}
        },
        html: {}
      },
      publicFiles: {},
      cloudFrontOrigins: {
        ssrApi: {}
      }
    };
  }

  buildSsrLambda(buildManifest) {
    const copyOperations = [
      [".next/serverless/pages", `./${SSR_LAMBDA_BUILD_DIR}/pages`],
      [
        path.join(__dirname, "ssr-handler.js"),
        `./${SSR_LAMBDA_BUILD_DIR}/index.js`
      ],
      [
        path.join(__dirname, "node_modules/next-aws-lambda"),
        `./${SSR_LAMBDA_BUILD_DIR}/node_modules/next-aws-lambda`
      ],
      [path.join(__dirname, "router.js"), `./${SSR_LAMBDA_BUILD_DIR}/router.js`]
    ];

    return Promise.all([
      ...copyOperations.map(([from, to]) => fse.copy(from, to)),
      fse.writeJson(`./${SSR_LAMBDA_BUILD_DIR}/manifest.json`, buildManifest)
    ]);
  }

  buildLambdaAtEdge(buildManifest) {
    return Promise.all([
      fse.copy(
        path.join(__dirname, "lambda-at-edge-handler.js"),
        `./${LAMBDA_AT_EDGE_BUILD_DIR}/index.js`
      ),
      fse.writeJson(
        `./${LAMBDA_AT_EDGE_BUILD_DIR}/manifest.json`,
        buildManifest
      )
    ]);
  }

  async build() {
    await nextBuild(path.resolve("./"));

    const pagesManifest = await this.readPagesManifest();
    const buildManifest = this.getBlankBuildManifest();

    const ssr = buildManifest.pages.ssr;
    const allRoutes = Object.keys(pagesManifest);

    allRoutes.forEach(r => {
      if (pagesManifest[r].endsWith(".html")) {
        buildManifest.pages.html[r] = pagesManifest[r];
      } else if (isDynamicRoute(r)) {
        const expressRoute = expressifyDynamicRoute(r);
        ssr.dynamic[expressRoute] = {
          file: pagesManifest[r],
          regex: pathToRegexStr(expressRoute)
        };
      } else {
        ssr.nonDynamic[r] = pagesManifest[r];
      }
    });

    const publicFiles = await this.readPublicFiles();

    publicFiles.forEach(pf => {
      buildManifest.publicFiles["/" + pf] = pf;
    });

    await fse.emptyDir(`./${SSR_LAMBDA_BUILD_DIR}`);
    await fse.emptyDir(`./${LAMBDA_AT_EDGE_BUILD_DIR}`);

    await this.buildSsrLambda(buildManifest);

    const backend = await this.load("@serverless/backend");
    const bucket = await this.load("@serverless/aws-s3");
    const cloudFront = await this.load("@serverless/aws-cloudfront");
    const lambda = await this.load("@serverless/aws-lambda");

    const bucketOutputs = await bucket({
      accelerated: true
    });

    const uploadHtmlPages = Object.values(buildManifest.pages.html).map(page =>
      bucket.upload({
        file: `./.next/serverless/${page}`,
        key: `static-pages/${page.replace("pages/", "")}`
      })
    );

    await Promise.all([
      bucket.upload({
        dir: "./.next/static",
        keyPrefix: "_next/static"
      }),
      bucket.upload({
        dir: "./static",
        keyPrefix: "static"
      }),
      bucket.upload({
        dir: "./public",
        keyPrefix: "public"
      }),
      ...uploadHtmlPages
    ]);

    const backendOutputs = await backend({
      code: {
        src: "./serverless-nextjs-tmp"
      }
    });

    buildManifest.cloudFrontOrigins = {
      ssrApi: {
        domainName: url.parse(backendOutputs.url).hostname
      },
      staticOrigin: {
        domainName: `${bucketOutputs.name}.s3.amazonaws.com`
      }
    };

    await this.buildLambdaAtEdge(buildManifest);

    const lambdaAtEdgeOutputs = await lambda({
      description: "Lambda@Edge for Next CloudFront distribution",
      handler: "index.handler",
      code: `./${LAMBDA_AT_EDGE_BUILD_DIR}`,
      role: {
        service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
        policy: {
          arn: "arn:aws:iam::aws:policy/AdministratorAccess"
        }
      }
    });

    const lambdaPublishOutputs = await lambda.publishVersion();

    await cloudFront({
      defaults: {
        ttl: 5,
        "lambda@edge": {
          "origin-request": `${lambdaAtEdgeOutputs.arn}:${lambdaPublishOutputs.version}`
        }
      },
      origins: [
        `${backendOutputs.url}`,
        {
          url: `http://${bucketOutputs.name}.s3.amazonaws.com`,
          private: true,
          pathPatterns: {
            "_next/*": {
              ttl: 86400
            },
            "static/*": {
              ttl: 86400
            }
          }
        }
      ]
    });
  }

  async remove() {
    const backend = await this.load("@serverless/backend");
    const bucket = await this.load("@serverless/aws-s3");
    const cloudfront = await this.load("@serverless/aws-cloudfront");

    await cloudfront.remove();
    await backend.remove();
    await bucket.remove();
  }
}

module.exports = NextjsComponent;
