# @bakidev/async-caller

AsyncCaller is a TypeScript library for making asynchronous calls with retry, concurrency, and rate limiting capabilities.
It utilizes TokenBucket module that you can find at "https://www.npmjs.com/package/@bakidev/token-bucket".

## Features

- **Rate Limiting**: Control the rate of requests using a token bucket algorithm.
- **Retry Mechanism**: Automatically retry failed requests with customizable retry options.
- **Automatic Check For 429 Erros**:If the function sent to the async caller is a function called with fetch(), it automatically checks the incoming headers for 429 and make the necessary adjustments to the tokenbucket of the caller accordingly if there is a 429 error.
  The delay amount is determined according to "Retry-After" header of the response. It works with Headers object used in modern fetch API and also plain objects. If there is no "Retry-After" to be found then default formula is used to calculate the delay amount by using backoffFactor of retryOptions (check Configuration Options - RetryOptions below).
- **Other Errors**: If the function sent to the async caller is fetch, it does not retry with error codes between 400 and 499. (except 429)
- **Concurrency Control**: Limit the number of concurrent tasks.
- **Type Safety**: Ensures type-safe responses when using `fetch`. If function using fetch is typesafe, then asyncCaller also returns typesafe value.

## Installation

To install the package, use npm or yarn:

```sh
npm install @bakidev/async-caller
```

or

```sh
yarn add @bakidev/async-caller
```

## Usage

### Quick Start

```typescript
import { AsyncCaller } from '@bakidev/async-caller';

// AsyncCaller constructor takes two optional parameters, tokenBucketOptions and retryOptions
// If they are not given as parameters, the default values (defined in the module) will be used.

const asyncCaller = new AsyncCaller();

async function fetchData() {
  // Your async function logic
}

asyncCaller
  .call(fetchData)
  .then((result) => console.log(result))
  .catch((error) => console.error(error));
```

### Set the tokenBucketOptions

```typescript
import { AsyncCaller } from '@bakidev/async-caller';

// Here we only specify tokenBucketOptions.
const asyncCaller = new AsyncCaller({
  tokenBucketOptions: {
    capacity: 10,
    fillPerWindow: 10,
    windowInMs: 1000,
  },
});

async function fetchData() {
  // Your async function logic
}

asyncCaller
  .call(fetchData)
  .then((result) => console.log(result))
  .catch((error) => console.error(error));
```

### Set the retryOptions

```typescript
// Instead of default options for retry we can set them ourselves.

import { AsyncCaller } from '@bakidev/async-caller';

const asyncCaller = new AsyncCaller({
  tokenBucketOptions: {
    capacity: 20,
    fillPerWindow: 100,
    windowInMs: 60000,
  },
  retryOptions: {
    maxRetries: 5,
    minDelayInMs: 500,
    maxDelayInMs: 20000,
    backoffFactor: 2,
  },
  concurrency: 10,
});

async function fetchData() {
  // Your async function logic
}

asyncCaller
  .call(fetchData)
  .then((result) => console.log(result))
  .catch((error) => console.error(error));
```

### Sending All Requests At Once

```typescript
/*
With the help of async caller, you can completely transfer the rate limiting issue to the async caller function and
send all requests at once with await Promise.all.
async caller works in accordance with the given limits.
Thanks to the async caller, your site can be used as quickly as possible within the specified rate limits.
*/
// Without async caller
  for (const user of users) {
    const userData = await fetch(https://www.somewebsite.com/fetchuserinfo/${user.id});
    // do something with userData
  }
  // too slow, each request has to wait the previous one to complete.

  // Without async caller
  await Promise.all(users.map(async user => {
    const userData = await fetch(https://www.somewebsite.com/fetchuserinfo/${user.id});
    // do something with userData
  }));
  // sends all of them together, but will probably get rate limited.

  // with async caller
  const asyncCaller = new AsyncCaller({
    tokenBucketOptions: {
      capacity: 10,
      fillPerWindow: 10,
      windowInMs: 1000,
    },
  });
  await Promise.all(users.map(async user => {
    const userData = await asyncCaller.call(async () => fetch(https://www.somewebsite.com/fetchuserinfo/${user.id}));
    // do something with userData
  }));

```

### Verbose Logging

When verbose logging is enabled, you will see detailed logs about the internal operations of the `AsyncCaller`. For example:

```plaintext
AsyncCaller: Running task... Concurrency: (1 / 10) (Queue length: 0)
AsyncCaller: Too many requests detected.
AsyncCaller: Max retries exceeded. Rejecting...
```

## Configuration Options

### TokenBucketOptions

- **capacity**: The maximum number of requests allowed in a window.
- **fillPerWindow**: The number of requests to allow per window. This determines the rate at which requests are allowed.
- **windowInMs**: The size of the window in milliseconds.
- **initialTokens**: The initial number of allowed requests. If not provided, it defaults to the capacity.

### RetryOptions

- **maxRetries**: The maximum number of retries. Default is 3. The maxRetries is the number of the extra tries.
  For example if maxRetries is set to 10, the total number of tries would be 11 with the first try.
- **minDelayInMs**: The minimum delay between retries in milliseconds. Default is 1000.
- **maxDelayInMs**: The maximum delay between retries in milliseconds. Default is 10000.
- **backoffFactor**: The factor by which the delay should be increased after each retry. Default is 2.

```typescript
/* In this example maxRetries is set to 1. It means that in total it will be tried two times (i.e. once for first try, once for retry.
  The minimum delay between retries (i.e. minDelayInMs) is set to 100 milliseconds.
  The maximum delay between retries (i.e. maxDelayInMs) is set to 10000 milliseconds.
  backoffFactor is set to 3, so the delay will be increased 3 times after each retry.
*/
import { AsyncCaller } from '@bakidev/async-caller';

const asyncCaller = new AsyncCaller({
  retryOptions: {
    maxRetries: 1,
    minDelayInMs: 100,
    maxDelayInMs: 10000,
    backoffFactor: 3,
  },
});
```

### Concurrency

- **concurrency**: The maximum number of concurrent tasks allowed. Default is 5.

```typescript
/* concurrency is set to 10. So maximum 10 tasks can be handles concurrently.
 */
import { AsyncCaller } from '@bakidev/async-caller';

const asyncCaller = new AsyncCaller({
  retryOptions: {
    maxRetries: 10,
    minDelayInMs: 300,
    maxDelayInMs: 15000,
    backoffFactor: 2,
  },
  concurrency: 10,
});
```
## Authors
Nurbaki Kasikci - [GitHub](https://github.com/mnkasikci)  - [Twitter](https://twitter.com/mnkasikci)

## Contribution
We welcome contributions to improve this package and encourage users to submit bug reports, feature requests, or any other contributions that can enhance the project. Please follow the guidelines below to contribute:
1. Report Issues: If you encounter any issues or have suggestions for improvements, please open an issue on [GitHub](https://github.com/grape-law-firm/token-bucket/issues) 
2. Pull Requests: You are welcome to [submit Pull Requests](https://github.com/grape-law-firm/token-bucket/pulls) (PRs) for bug fixes or new features. Make sure to follow the established coding conventions and explain the purpose of your changes. 
