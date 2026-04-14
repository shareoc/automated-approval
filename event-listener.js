// This dotenv import is required for the `.env` file to be read
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const sharetribeIntegrationSdk = require('sharetribe-flex-integration-sdk');
const { UUID } = sharetribeIntegrationSdk.types;

// Create rate limit handler for queries.
// NB! If you are using the script in production environment,
// you will need to use sharetribeIntegrationSdk.util.prodQueryLimiterConfig
const queryLimiter = sharetribeIntegrationSdk.util.createRateLimiter(
  sharetribeIntegrationSdk.util.devQueryLimiterConfig
);

// Create rate limit handler for commands.
// NB! If you are using the script in production environment,
// you will need to use sharetribeIntegrationSdk.util.prodCommandLimiterConfig
const commandLimiter = sharetribeIntegrationSdk.util.createRateLimiter(
  sharetribeIntegrationSdk.util.devCommandLimiterConfig
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const integrationSdk = sharetribeIntegrationSdk.createInstance({
  // These two env vars need to be set in the `.env` file.
  clientId: process.env.SHARETRIBE_INTEGRATION_CLIENT_ID,
  clientSecret: process.env.SHARETRIBE_INTEGRATION_CLIENT_SECRET,

  // Pass rate limit handlers
  queryLimiter: queryLimiter,
  commandLimiter: commandLimiter,

  // Normally you can just skip setting the base URL and just use the
  // default that the `createInstance` uses. We explicitly set it here
  // for local testing and development.
  baseUrl: process.env.SHARETRIBE_INTEGRATION_BASE_URL || 'https://flex-integ-api.sharetribe.com',
});

const startTime = new Date();

// Polling interval (in ms) when all events have been fetched. Keeping this at 1
const pollIdleWait = 60000;
// Polling interval (in ms) when a full page of events is received and there may be more
const pollWait = 250;

const queryEvents = (args) => {
  var filter = {eventTypes: "listing/created,listing/updated,user/created"};
  return integrationSdk.events.query(
    {...args, ...filter}
  );
};

const askAnthropicForApproval = async (listing, listingId, authorId) => {
  const { title, description, price, state, publicData } = listing.attributes;
  const listingInfo = JSON.stringify({ listingId, authorId, title, description, price, state, publicData }, null, 2);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are a listing moderation assistant for a marketplace for collectors items: hellenic and ptolemaic coinage. Review the listing and decide if it should be approved.

Reject if any of the following are true:
- Title or description is missing, gibberish, or placeholder text
- The listing is for something that is not related to the marketplace (e.g. consumables, illegal items)
- Content is offensive, discriminatory, or violates basic community standards
- The listing appears to be a scam or duplicate spam listing

Approve if the listing has a clear title and a coherent description.

Respond with a JSON object: { "decision": "YES", "reasoning": "..." } or { "decision": "NO", "reasoning": "..." }`,
    messages: [
      {
        role: 'user',
        content: `Please review this listing and decide if it should be approved:\n\n${listingInfo}`,
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['YES', 'NO'],
            },
            reasoning: {
              type: 'string',
            },
          },
          required: ['decision', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
  });

  const result = JSON.parse(message.content[0].text);
  return result;
};

const askAnthropicForUserApproval = async (user, userId) => {
  const { email, createdAt, profile} = user.attributes;
  console.log(user)
  const userInfo = JSON.stringify({ userId, email, createdAt, profile }, null, 2);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are a user moderation assistant for a marketplace for collectors of hellenic and ptolemaic coinage. Review the new user account and decide if it should be approved.

Reject if any of the following are true:
- The profile name appears to be fake, gibberish, or a bot pattern
- The email domain looks suspicious
- The bio or public data contains offensive content
- The account shows strong signs of being fraudulent or spam

Approve if the account appears to be a genuine person. 

Respond with a JSON object: { "decision": "YES", "reasoning": "..." } or { "decision": "NO", "reasoning": "..." }`,
    messages: [
      {
        role: 'user',
        content: `Please review this user account and decide if it should be approved:\n\n${userInfo}`,
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['YES', 'NO'],
            },
            reasoning: {
              type: 'string',
            },
          },
          required: ['decision', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
  });

  const result = JSON.parse(message.content[0].text);
  return result;
};

const analyzeEvent = async (event) => {
  if (event.attributes.resourceType == "user") {
    const { resourceId, resource: user, eventType } = event.attributes;
    const userId = resourceId.uuid;
    const userDetails = `user ID ${userId}, email: ${user.attributes.email}`;

    if (eventType === "user/created") {
      console.log(`A new user has registered: ${userDetails}`);
      const { decision, reasoning } = await askAnthropicForUserApproval(user, userId);
      console.log(`Anthropic approval decision: ${decision}`);
      console.log(`Reasoning: ${reasoning}`);
      if (decision === 'YES') {
        integrationSdk.users.approve({ id: new UUID(userId) }).then(res => {
          console.log("User approved")
        });
      } else {
      }
    }
  } else if (event.attributes.resourceType == "listing") {
    const {
      resourceId,
      resource: listing,
      previousValues,
      eventType,
    } = event.attributes;
    const listingId = resourceId.uuid;
    const authorId = listing.relationships.author.data.id.uuid;
    const listingState = listing.attributes.state;
    const listingDetails = `listing ID ${listingId}, author ID: ${authorId}`;
    const {state: previousState} = previousValues.attributes || {};

    const isPublished = listingState === "published";
    const isPendingApproval = listingState === "pendingApproval";
    const wasDraft = previousState === "draft";
    const wasPendingApproval = previousState === "pendingApproval";

    switch(eventType) {
    case "listing/created":
      if (isPendingApproval) {
        console.log(`A new listing is pending approval: ${listingDetails}`);
        const { decision: approvalDecisionCreated, reasoning: reasoningCreated } = await askAnthropicForApproval(listing, listingId, authorId);
        console.log(`Anthropic approval decision: ${approvalDecisionCreated}`);
        console.log(`Reasoning: ${reasoningCreated}`);
        if (approvalDecisionCreated === 'YES') {
          console.log("APPROVED")
          integrationSdk.listings.approve({ id: new UUID(listingId) }, { expand: true }).then(res => {
            // res.data
          });
        } else {
          console.log("NOT APPROVED")
        }
      } else if (isPublished) {
        console.log(`A new listing has been published: ${listingDetails}`);
      }
      break;
    case "listing/updated":
      if (isPublished && wasPendingApproval) {
        console.log(`A listing has been approved by operator: ${listingDetails}`);
      } else if (isPublished && wasDraft) {
        console.log(`A new listing has been published: ${listingDetails}`);
      } else if (isPendingApproval && wasDraft) {
        console.log(`A new listing is pending approval: ${listingDetails}`);
        const { decision: approvalDecisionUpdated, reasoning: reasoningUpdated } = await askAnthropicForApproval(listing, listingId, authorId);
        console.log(`Anthropic approval decision: ${approvalDecisionUpdated}`);
        console.log(`Reasoning: ${reasoningUpdated}`);
        if (approvalDecisionUpdated === 'YES') {
          integrationSdk.listings.approve({ id: new UUID(listingId) }, { expand: true }).then(res => {
            // res.data
          });
        } else {
        }
      }
      break;
    }
  }
};

const pollLoop = (sequenceId) => {
  var params = sequenceId ? {startAfterSequenceId: sequenceId} : {createdAtStart: startTime};
  queryEvents(params)
    .then(async res => {
      const events = res.data.data;
      const lastEvent = events[events.length - 1];
      const fullPage = events.length === res.data.meta.perPage;
      const delay = fullPage ? pollWait : pollIdleWait;
      const lastSequenceId = lastEvent ? lastEvent.attributes.sequenceId : sequenceId;

      await Promise.all(events.map(e => analyzeEvent(e)));

      setTimeout(() => {pollLoop(lastSequenceId);}, delay);
    });
};

console.log("Press <CTRL>+C to quit.");
console.log("Starting event polling from current time.");

pollLoop(null);