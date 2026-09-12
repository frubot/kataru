import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { VRMHumanoid } from '@pixiv/three-vrm';

/** A neutral standing pose, shared by the game view and costume preview. */
export function applyVrmRelaxedPose(humanoid: VRMHumanoid): void {
    humanoid.resetNormalizedPose();
    const armOut = MathUtils.degToRad(14);
    const elbowBend = MathUtils.degToRad(12);

    for (const side of ['left', 'right'] as const) {
        const upper = humanoid.getNormalizedBoneNode(`${side}UpperArm`);
        const lower = humanoid.getNormalizedBoneNode(`${side}LowerArm`);
        const hand = humanoid.getNormalizedBoneNode(`${side}Hand`);
        if (!upper || !lower || !hand || lower.position.lengthSq() === 0 || hand.position.lengthSq() === 0) continue;

        // Normalized bones retain the model's rest directions. VRM 0 and 1 have
        // opposite X/Z axes, so derive the side and forward signs from the rig.
        const outward = Math.sign(lower.position.x);
        if (!outward) continue;
        const forward = side === 'left' ? outward : -outward;
        upper.quaternion.setFromUnitVectors(
            lower.position.clone().normalize(),
            new Vector3(outward * Math.sin(armOut), -Math.cos(armOut), 0),
        );
        lower.quaternion.setFromUnitVectors(
            hand.position.clone().normalize(),
            new Vector3(outward * Math.cos(elbowBend), 0, forward * Math.sin(elbowBend)),
        );

        // Keep palms facing the thighs and relax the fingers without making a
        // fist. Leave the thumb base's authored spread intact.
        for (const [finger, curl] of [['Index', 1], ['Middle', 1.1], ['Ring', 1.2], ['Little', 1.3]] as const) {
            for (const [joint, degrees] of [['Proximal', 12], ['Intermediate', 18], ['Distal', 10]] as const) {
                const bone = humanoid.getNormalizedBoneNode(`${side}${finger}${joint}`);
                if (bone) bone.rotation.z = -outward * MathUtils.degToRad(degrees * curl);
            }
        }
        for (const joint of ['Proximal', 'Distal'] as const) {
            const thumb = humanoid.getNormalizedBoneNode(`${side}Thumb${joint}`);
            if (thumb) thumb.rotation.z = -outward * MathUtils.degToRad(8);
        }
    }
}

/** Layer idle movement over the relaxed pose without accumulating rotations. */
export function createVrmIdleAnimation(humanoid: VRMHumanoid): (elapsed: number, moving?: boolean) => void {
    const names = [
        'spine', 'chest', 'neck', 'head',
        'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
    ] as const;
    const bones = new Map(names.flatMap((name) => {
        const node = humanoid.getNormalizedBoneNode(name);
        return node ? [[name, { node, rest: node.quaternion.clone() }] as const] : [];
    }));
    const angles = new Euler();
    const offset = new Quaternion();
    const forward = Math.sign(humanoid.getNormalizedBoneNode('leftLowerArm')?.position.x ?? 0)
        || -Math.sign(humanoid.getNormalizedBoneNode('rightLowerArm')?.position.x ?? 0) || 1;
    const rotate = (name: typeof names[number], x: number, y: number, z: number) => {
        const bone = bones.get(name);
        // Parent-space offsets keep the lowered arms' rest rotations intact.
        if (bone) bone.node.quaternion.premultiply(offset.setFromEuler(angles.set(x, y, z)));
    };

    return (elapsed, moving = true) => {
        for (const { node, rest } of bones.values()) node.quaternion.copy(rest);
        if (!moving) return;

        const easeIn = 1 - Math.exp(-elapsed * 2);
        const breath = Math.sin(elapsed * 1.65) * easeIn;
        const sway = (Math.sin(elapsed * 0.55) * 0.022 + Math.sin(elapsed * 1.13) * 0.008) * easeIn;
        const turn = (Math.sin(elapsed * 0.37) * 0.045 + Math.sin(elapsed * 0.83) * 0.015) * easeIn;

        // Animate above the hips so the feet stay planted. Chest/neck are optional.
        rotate('spine', breath * (bones.has('chest') ? 0.01 : 0.026) * forward, turn * 0.2, sway * forward);
        rotate('chest', breath * 0.016 * forward, turn * 0.15, -sway * 0.3 * forward);
        rotate('neck', breath * -0.006 * forward, turn * 0.2, -sway * 0.15 * forward);
        rotate('head', Math.sin(elapsed * 0.91) * 0.018 * easeIn * forward, turn, -sway * 0.55 * forward);

        for (const side of ['left', 'right'] as const) {
            const outward = (side === 'left' ? 1 : -1) * forward;
            const lag = side === 'left' ? 0.4 : 1.1;
            const swing = Math.sin(elapsed * 1.1 + lag) * 0.025 * easeIn;
            rotate(`${side}UpperArm`, (swing - breath * 0.008) * forward, 0, -outward * breath * 0.012 - sway * 0.3 * forward);
            rotate(`${side}LowerArm`, 0, -outward * Math.sin(elapsed * 1.1 + lag - 0.35) * 0.018 * easeIn, 0);
            rotate(`${side}Hand`, 0, 0, outward * Math.sin(elapsed * 1.1 + lag - 0.7) * 0.018 * easeIn);
        }
    };
}
