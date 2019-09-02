import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import sns = require('@aws-cdk/aws-sns');
import iam = require('@aws-cdk/aws-iam');
import ssm = require('@aws-cdk/aws-ssm');
import appSync = require('@aws-cdk/aws-appsync');
import processBooking = require('./process-booking');

export interface BookingProps {
    readonly bookingTable: string;
    readonly flightTable: string;
    readonly stage: string;
    readonly collectPaymentFunction: string;
    readonly refundPaymentFunction: string;
    readonly appSyncApiId: string;
}

// TODO Extract into a utils directory
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

export class BookingStack extends cdk.Stack {
    public readonly bookingSnsTopic: string;

    constructor(scope: cdk.App, id: string, props: BookingProps) {
        super(scope, id);

        const confirmBooking = new lambda.Function(this, "ConfirmBooking", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/booking/src/confirm-booking'),
            handler: 'confirm.lambda_handler',
            environment: {
                BOOKING_TABLE_NAME: props.bookingTable
            },
            initialPolicy: [DynamoDBCrudPolicy(props.bookingTable)]
        });

        const cancelBooking = new lambda.Function(this, "CancelBooking", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/booking/src/cancel-booking'),
            handler: 'cancel.lambda_handler',
            environment: {
                BOOKING_TABLE_NAME: props.bookingTable
            },
            initialPolicy: [DynamoDBCrudPolicy(props.bookingTable)]
        });

        const reserveBooking = new lambda.Function(this, "reserveBooking", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/booking/src/reserve-booking'),
            handler: 'reserve.lambda_handler',
            environment: {
                BOOKING_TABLE_NAME: props.bookingTable
            },
            initialPolicy: [DynamoDBCrudPolicy(props.bookingTable)]
        });

        const bookingTopic = new sns.Topic(this, "BookingTopic")
        this.bookingSnsTopic = bookingTopic.topicArn;

        const notifyBooking = new lambda.Function(this, "notifyBooking", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/booking/src/notify-booking'),
            handler: 'notify.lambda_handler',
            environment: {
                BOOKING_TOPIC: bookingTopic.topicArn
            }
        });
        bookingTopic.grantPublish(notifyBooking)

        const bookingMachine = new processBooking.ProcessBookingConstruct(this, "ProcessBooking", {
            reserveBookingArn: reserveBooking.functionArn,
            cancelBookingArn: cancelBooking.functionArn,
            confirmBookingArn: confirmBooking.functionArn,
            notifyBookingArn: notifyBooking.functionArn,
            collectPaymentArn: props.collectPaymentFunction,
            refundPaymentArn: props.refundPaymentFunction,
            bookingTable: props.bookingTable,
            flightTable: props.flightTable
        })

        new ssm.StringParameter(this, "BookingTopicParameter", {
            stringValue: bookingTopic.topicArn,
            description: "Booking SNS Topic ARN",
            parameterName: `/service/booking/booking-topic/${props.stage}`
        })

        new ssm.StringParameter(this, "ProcessBookingParameter", {
            stringValue: bookingMachine.stateMachineArn,
            description: "Step Functions State Machine ARN",
            parameterName: `/service/booking/process-booking-state-machine/${props.stage}`
        })

        const appSyncRole = new iam.Role(this, "AppsyncStepFunctionsIamRole", {
            assumedBy: new iam.ServicePrincipal('appsync'),
            path: '/',
            inlinePolicies: {
                StatesExecutionPolicy: new iam.PolicyDocument({
                    assignSids: true,
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ["states:StartExecution"],
                            resources: [bookingMachine.stateMachineArn]
                        })
                    ]
                })     
            }
        })

        const appsyncStepFunctionsDataSource = new appSync.CfnDataSource(
            this,
            "AppsyncStepFunctionsDataSource",
            {
                apiId: props.appSyncApiId,
                name: "ProcessBookingSFN",
                description: "Step Functions State Machine for Booking",
                type: "HTTP",
                serviceRoleArn: appSyncRole.roleArn,
                httpConfig: {
                    endpoint: `https://states.${cdk.Aws.REGION}.amazonaws.com/`,
                    authorizationConfig: {
                        authorizationType: "AWS_IAM",
                        awsIamConfig: {
                            signingRegion: `${cdk.Aws.REGION}`,
                            signingServiceName: "states"
                        }
                    }
                }
            }
        );

        const processBookingMutationResolver = new appSync.CfnResolver(
            this,
            "ProcessBookingMutationResolver",
            {
                apiId: props.appSyncApiId,
                typeName: "Mutation",
                fieldName: "processBooking",
                dataSourceName: appsyncStepFunctionsDataSource.name,
                requestMappingTemplate: `
                $util.qr($ctx.stash.put("outboundFlightId", $ctx.args.input.bookingOutboundFlightId))
                $util.qr($ctx.stash.put("paymentToken", $ctx.args.input.paymentToken))
                $util.qr($ctx.stash.put("customer", $ctx.identity.sub))
                $util.qr($ctx.stash.put("executionId", $util.autoId()))
                $util.qr($ctx.stash.put("createdAt", $util.time.nowISO8601()))
                #set( $payload = {
                    "outboundFlightId": $ctx.stash.outboundFlightId,
                    "customerId": $context.identity.sub,
                    "chargeId": $ctx.stash.paymentToken,
                    "bookingTable": "${props.bookingTable}",
                    "flightTable": "${props.flightTable}",
                    "name": $ctx.stash.executionId,
                    "createdAt": $ctx.stash.createdAt
                })
                {
                    "version": "2018-05-29",
                    "method": "POST",
                    "resourcePath": "/",
                    "params": {
                        "headers": {
                        "content-type": "application/x-amz-json-1.0",
                        "x-amz-target":"AWSStepFunctions.StartExecution"
                        },
                        "body": {
                        "stateMachineArn": "${bookingMachine.stateMachineArn}",
                        "input": "$util.escapeJavaScript($util.toJson($payload))"
                        }
                    }
                }`,
                responseMappingTemplate: `
                {
                    "id": "$ctx.stash.executionId",
                    "status": "PENDING"
                }`
            }
        );

        processBookingMutationResolver.addDependsOn(appsyncStepFunctionsDataSource);

    }
}