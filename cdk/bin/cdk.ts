#!/usr/bin/env node
import cdk = require('@aws-cdk/core');
import { PaymentStack } from '../lib/payment/payment';
import { CatalogStack } from '../lib/catalog/catalog';
import { BookingStack } from '../lib/booking/booking';
import { LoyaltyStack } from '../lib/loyalty/loyalty';

const app = new cdk.App();

const bookingTableName = app.node.tryGetContext("bookingTable");
const flightTableName = app.node.tryGetContext("flightTable");
const stage = app.node.tryGetContext("stage");
const appSyncApiId = app.node.tryGetContext("appSyncApiId");

const paymentStack = new PaymentStack(app, 'PaymentStack', {
    stripeKey: "ABCDEFGHI",
    stage: stage
});

const catalogStack = new CatalogStack(app, 'CatalogStack', {
    flightTable: flightTableName,
    stage: stage
});

const bookingStack = new BookingStack(app, 'BookingStack', {
    bookingTable: bookingTableName,
    flightTable: flightTableName,
    stage: stage,
    collectPaymentFunction: paymentStack.collectPaymentArn,
    refundPaymentFunction: paymentStack.refundPaymentArn,
    appSyncApiId: appSyncApiId,
});

new LoyaltyStack(app, 'LoyaltyStack', {
    stage: stage,
    appSyncApiId: appSyncApiId,
    bookingSNSTopic: bookingStack.bookingSnsTopic
});
