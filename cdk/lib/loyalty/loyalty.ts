import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import sns = require('@aws-cdk/aws-sns');
import iam = require('@aws-cdk/aws-iam');
import ssm = require('@aws-cdk/aws-ssm');
import sam = require('@aws-cdk/aws-sam');
import appSync = require('@aws-cdk/aws-appsync');
import dynamodb = require('@aws-cdk/aws-dynamodb');

export interface LoyaltyProps {
    readonly stage: string;
    readonly bookingSNSTopic: string;
    readonly appSyncApiId: string;
}

function DynamoDBCrudPolicy(tableName: string): iam.PolicyStatement {
    return new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            "dynamodb:GetItem",
            "dynamodb:DeleteItem",
            "dynamodb:PutItem",
            "dynamodb:Scan",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:BatchGetItem",
            "dynamodb:DescribeTable"
          ],
        resources: [
            `arn:${cdk.Aws.PARTITION}:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${tableName}`,
            `arn:${cdk.Aws.PARTITION}:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${tableName}/index/*`
        ]
    });
}

export class LoyaltyStack extends cdk.Stack {

    constructor(scope: cdk.App, id: string, props: LoyaltyProps) {
        super(scope, id);

        const loyaltyDataTable = new dynamodb.Table(this, "LoyaltyDataTable", {
            tableName: `LoyaltyData-${cdk.Aws.STACK_NAME}`,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            partitionKey: {
                type: dynamodb.AttributeType.STRING,
                name: "Id"
            },
            serverSideEncryption: true
        });

        loyaltyDataTable.addGlobalSecondaryIndex({
            partitionKey: {
                type: dynamodb.AttributeType.STRING,
                name: "customerId"
            },
            sortKey: {
                type: dynamodb.AttributeType.STRING,
                name: "flag"
            },
            indexName: "customer-flag",
            projectionType: dynamodb.ProjectionType.ALL
        });

        const ingestFunc = new lambda.Function(this, "IngestFunc", {
            runtime: lambda.Runtime.NODEJS_8_10,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/loyalty/src/ingest'),
            handler: 'index.handler',
            environment: {'FLIGHT_TABLE_NAME': loyaltyDataTable.tableName},
            initialPolicy: [DynamoDBCrudPolicy(loyaltyDataTable.tableName)]
        });
        //TODO Add SNS Listener

        const getFunc = new lambda.Function(this, "GetFunc", {
            runtime: lambda.Runtime.NODEJS_8_10,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/loyalty/src/get'),
            handler: 'index.handler',
            environment: {'FLIGHT_TABLE_NAME': loyaltyDataTable.tableName},
            initialPolicy: [DynamoDBCrudPolicy(loyaltyDataTable.tableName)]
        });

        getFunc.grantInvoke(new iam.ServicePrincipal("apigateway"))


        // TODO Make this better
        const loyaltyApi = new sam.CfnApi(this, "LoyaltyApi", {
            name: `LoyaltyApi-${props.stage}`,
            stageName: 'Prod',
            methodSettings: [{
                MetricsEnabled: true,
                ResourcePath: '/*',
                HttpMethod: '*',
                ThrottlingRateLimit: 100,
                ThrottlingBurstLimit: 50
            }],
            auth: {
                defaultAuthorizer: "AWS_IAM"
            },
            definitionBody: {
                "swagger": "2.0",
                "info": {
                    "title": "Richard",
                    "version": "3"
                },
                "x-amazon-apigateway-request-validator": "all",
                "x-amazon-apigateway-request-validators": {
                    "all": {
                        "validateRequestBody": "true",
                        "validateRequestParameters": "true"
                    }
                },
                "produces":[
                    "application/json"
                ],
                "paths": {
                    "/loyalty/{customerId}":{
                        "get": {
                            "summary": 'Fetch customer loyalty points',
                            "paramters": [{
                                "name": "customerId",
                                "in": "path",
                                "required": true,
                                "type": "string",
                            }],
                            "x-amazon-apigateway-integration": {
                                "httpMethod": "POST",
                                "type": "aws_proxy",
                                "uri": `arn:aws:apigateway:${cdk.Aws.REGION}:lambda:path/2015-03-31/functions/${getFunc.functionArn}/invocations`
                            }
                        }
                    }
                }
            }
        })

        const appsyncLoyaltyRestApiIamRole = new iam.Role(this, "AppsyncLoyaltyRestApiIamRole", {
            assumedBy: new iam.ServicePrincipal('appsync'),
            path: '/',
            inlinePolicies: {
                LoyaltyApiInvoke: new iam.PolicyDocument({
                    assignSids: true,
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ["execute-api:Invoke"],
                            resources: [`arn:aws:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${loyaltyApi.ref}/*/*/*`]
                        })
                    ]
                })     
            }
        })

        const appsyncLoyaltyApiDataSource = new appSync.CfnDataSource(
            this,
            "AppsyncLoyaltyApiDataSource",
            {
                apiId: props.appSyncApiId,
                name: "LoyaltyRestApi",
                description: "Step Functions State Machine for Booking",
                type: "HTTP",
                serviceRoleArn: appsyncLoyaltyRestApiIamRole.roleArn,
                httpConfig: {
                    endpoint: `https://${loyaltyApi.ref}.execute-api.${cdk.Aws.REGION}.amazonaws.com`,
                    authorizationConfig: {
                        authorizationType: "AWS_IAM",
                        awsIamConfig: {
                            signingRegion: `${cdk.Aws.REGION}`,
                            signingServiceName: "execute-api"
                        }
                    }
                }
            }
        );

        const getLoyaltyQueryResolver = new appSync.CfnResolver(
            this,
            "GetLoyaltyQueryResolver",
            {
                apiId: props.appSyncApiId,
                typeName: "Query",
                fieldName: "getLoyalty",
                dataSourceName: appsyncLoyaltyApiDataSource.name,
                requestMappingTemplate: `
                ## Retrieve customer ID from query args; Injects current authenticated session if null
                #set( $customer = $util.defaultIfNull($ctx.args.customer, $ctx.identity.claims.get("sub")) )
                ## [Start] ** Static Group Authorization Checks **
                ## Authorization rule: Allow groups to fetch loyalty (e.g. Admins, Travel agency, etc.) **
                #set( $userGroups = $util.defaultIfNull($ctx.identity.claims.get("cognito:groups"), []) )
                #set( $allowedGroups = ["Admin"] )
                #set($isStaticGroupAuthorized = $util.defaultIfNull($isStaticGroupAuthorized, false))
                #foreach( $userGroup in $userGroups )
                    #foreach( $allowedGroup in $allowedGroups )
                    #if( $allowedGroup == $userGroup )
                        #set( $isStaticGroupAuthorized = true )
                    #end
                    #end
                #end
                ## [End] ** Static Group Authorization Checks **
                ## [Start] ** Owner Authorization Checks **
                #set( $isOwnerAuthorized = $util.defaultIfNull($isOwnerAuthorized, false) )
                ## Authorization rule: Allows customers to fetch their own Loyalty data
                ## retrieve customer ID from authenticated session
                #set( $identityValue = $util.defaultIfNull($ctx.identity.claims.get("sub"), "___xamznone____") )
                #if( $customer == $identityValue )
                    #set( $isOwnerAuthorized = true )
                #end
                ## [End] ** Owner Authorization Checks **
                ## [Start] ** Throw if unauthorized **
                #if( !($isStaticGroupAuthorized == true || $isOwnerAuthorized == true) )
                    $util.unauthorized()
                #end
                ## [End] Throw if unauthorized **
                {
                    "version": "2018-05-29",
                    "method": "GET",
                    "resourcePath": "/Prod/loyalty/$customer",
                    "params":{
                    "headers": {
                        "Content-Type" : "application/json"
                    }
                    }
                }`,
                responseMappingTemplate: `
                #if($ctx.error)
                    $util.error($ctx.error.message, $ctx.error.type)
                #end
                ## If the response is not 200 then return an error. Else return the body
                #if($ctx.result.statusCode == 200)
                    $ctx.result.body
                #else
                    $util.error($ctx.result.body)
                #end`
            }
        );

        getLoyaltyQueryResolver.addDependsOn(appsyncLoyaltyApiDataSource);


        new ssm.StringParameter(this, "ProcessBookingParameter", {
            stringValue: `https://${loyaltyApi.ref}.execute-api.${cdk.Aws.REGION}.amazonaws.com/Prod`,
            description: "Step Functions State Machine ARN",
            parameterName: `/service/loyalty/api-endpoint/${props.stage}`
        });
    }
}