export function assertDeploymentApproval(env,sha){
 if(env.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||env.GITHUB_REF_NAME!=='deploy/brat-accountant'||!/^[a-f0-9]{40}$/.test(sha)||env.ACCOUNTANT_APPROVED_SHA!==sha)throw Error('Explicit owner-approved source SHA and deployment branch are required');
}
