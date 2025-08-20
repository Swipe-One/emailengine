#!/bin/sh

# Get the current branch name and commit hash
if [ -f ".git/HEAD" ]; then
    HEAD_CONTENT=$(cat .git/HEAD)
    if echo "$HEAD_CONTENT" | grep -q "^ref: "; then
        # HEAD points to a branch reference
        CURRENT_BRANCH=$(echo "$HEAD_CONTENT" | sed 's/^ref: refs\/heads\///')
        if [ -f ".git/refs/heads/$CURRENT_BRANCH" ]; then
            COMMIT_HASH=$(cat .git/refs/heads/$CURRENT_BRANCH)
        else
            COMMIT_HASH="unknown"
        fi
    else
        # HEAD contains a direct commit hash (detached HEAD)
        COMMIT_HASH="$HEAD_CONTENT"
    fi
else
    COMMIT_HASH="unknown"
fi
TIMESTAMP=$(node -e 'console.log(Date.now())')
cat >version-info.json <<EOL
{
    "commit": "${COMMIT_HASH}",
    "time": "${TIMESTAMP}"
}
EOL
