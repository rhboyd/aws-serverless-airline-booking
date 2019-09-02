import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import sam = require('@aws-cdk/aws-sam');
import ssm = require('@aws-cdk/aws-ssm');

export interface PaymentProps {
    readonly stage: string;
    readonly stripeKey: string;
}


export class PaymentStack extends cdk.Stack {
    public readonly collectPaymentArn: string;
    public readonly refundPaymentArn: string;

    constructor(scope: cdk.App, id: string, props: PaymentProps) {
        super(scope, id);

        new ssm.StringParameter(this, "StripKeyParameter", {
            stringValue: `${props.stripeKey}`,
            description: "API Key for Stripe",
            parameterName: `service/payment/stripe/${props.stage}`
        });

        const stripePaymentApplication = new sam.CfnApplication(this, "StripePaymentApplication", {
            location: {
                applicationId: "arn:aws:serverlessrepo:us-east-1:375983427419:applications/api-lambda-stripe-charge",
                semanticVersion: "4.4.0"
            },
            parameters: {
                EnableInstantCapture: "false",
                SSMParameterPath: `service/payment/stripe/${props.stage}`
            }
        });

        const collectPayment = new lambda.Function(this, "CollectPayment", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/payment/src/collect-payment'),
            handler: 'collect.lambda_handler',
            environment: {
                PAYMENT_API_URL: stripePaymentApplication.getAtt("Outputs.CaptureApiUrl")
            }
        });

        this.collectPaymentArn = collectPayment.functionArn;

        const refundPayment = new lambda.Function(this, "refundPayment", {
            runtime: lambda.Runtime.PYTHON_3_7,
            timeout: cdk.Duration.seconds(10),
            code: new lambda.AssetCode('../src/backend/payment/src/refund-payment'),
            handler: 'refund.lambda_handler',
            environment: {
                PAYMENT_API_URL: stripePaymentApplication.getAtt("Outputs.RefundApiUrl")
            }
        });

        this.refundPaymentArn = refundPayment.functionArn;
    }
}