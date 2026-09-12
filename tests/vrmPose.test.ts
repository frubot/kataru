import { describe, expect, test } from 'vitest';
import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { VRMHumanoid, type VRMHumanBoneName, type VRMHumanBones } from '@pixiv/three-vrm';
import { applyVrmRelaxedPose, createVrmIdleAnimation } from '../lib/vrmPose';

function createHumanoid(forward: number, scale: number, optionalBones = true) {
    const root = new Object3D();
    const bones = {} as VRMHumanBones;
    const add = (name: VRMHumanBoneName, parent: Object3D, position: number[]) => {
        const node = new Object3D();
        parent.add(node);
        node.position.copy(parent.worldToLocal(new Vector3(...position).multiplyScalar(scale)));
        // Different raw bone axes must produce the same pose through normalization.
        node.quaternion.copy(parent.getWorldQuaternion(new Quaternion()).invert())
            .multiply(new Quaternion().setFromEuler(new Euler(0.2, -0.3, 0.1)));
        bones[name] = { node };
        return node;
    };
    const hips = add('hips', root, [0, 0.9, 0]);
    const spine = add('spine', hips, [0, 1.1, 0]);
    add('head', spine, [0, 1.6, 0]);
    for (const side of ['left', 'right'] as const) {
        const sign = (side === 'left' ? 1 : -1) * forward;
        const shoulder = optionalBones ? add(`${side}Shoulder`, spine, [sign * 0.1, 1.4, 0]) : spine;
        const upper = add(`${side}UpperArm`, shoulder, [sign * 0.18, 1.4, 0]);
        const lower = add(`${side}LowerArm`, upper, [sign * 0.4, 1.4, 0]);
        const hand = add(`${side}Hand`, lower, [sign * 0.6, 1.4, 0]);
        if (optionalBones) {
            const proximal = add(`${side}MiddleProximal`, hand, [sign * 0.66, 1.4, 0]);
            const intermediate = add(`${side}MiddleIntermediate`, proximal, [sign * 0.69, 1.4, 0]);
            add(`${side}MiddleDistal`, intermediate, [sign * 0.71, 1.4, 0]);
        }
        const thigh = add(`${side}UpperLeg`, hips, [sign * 0.1, 0.85, 0]);
        const shin = add(`${side}LowerLeg`, thigh, [sign * 0.1, 0.45, 0]);
        add(`${side}Foot`, shin, [sign * 0.1, 0.05, 0]);
    }
    const humanoid = new VRMHumanoid(bones);
    root.add(humanoid.normalizedHumanBonesRoot);
    // Match rotateVRM0: both generations should face +Z in the displayed scene.
    if (forward < 0) root.rotation.y = Math.PI;
    return { root, humanoid };
}

describe('relaxed VRM pose', () => {
    test.each([{ forward: 1, scale: 0.65 }, { forward: -1, scale: 1.8 }])(
        'lowers arms and bends elbows forward across rig axes and proportions: $forward',
        ({ forward, scale }) => {
            const { root, humanoid } = createHumanoid(forward, scale);
            applyVrmRelaxedPose(humanoid);
            humanoid.update();
            root.updateMatrixWorld(true);
            for (const side of ['left', 'right'] as const) {
                const position = (name: VRMHumanBoneName) => humanoid.getRawBoneNode(name)!.getWorldPosition(new Vector3());
                const upper = position(`${side}UpperArm`);
                const lower = position(`${side}LowerArm`);
                const hand = position(`${side}Hand`);
                const arm = lower.clone().sub(upper).normalize();
                const forearm = hand.clone().sub(lower).normalize();
                expect(arm.y).toBeLessThan(-0.94);
                expect(forearm.y).toBeLessThan(-0.9);
                expect(hand.z - lower.z).toBeGreaterThan(0.02 * scale);
                expect(Math.abs(hand.x)).toBeGreaterThan(Math.abs(upper.x));
                expect(arm.angleTo(forearm)).toBeGreaterThan(0.1);
                expect(arm.angleTo(forearm)).toBeLessThan(0.4);

                const normalizedHand = humanoid.getNormalizedBoneNode(`${side}Hand`)!;
                const tip = humanoid.getNormalizedBoneNode(`${side}MiddleDistal`)!.getWorldPosition(new Vector3());
                // Fingers curl toward the palm, including on rigs facing -Z.
                expect(normalizedHand.worldToLocal(tip).y).toBeLessThan(-0.01 * scale);
            }
        },
    );

    test('supports models without optional shoulder/finger bones and leaves the stance intact', () => {
        const { humanoid } = createHumanoid(1, 1, false);
        applyVrmRelaxedPose(humanoid);
        for (const name of ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'] as const) {
            const bone = humanoid.getNormalizedBoneNode(name)!;
            expect(bone.position.toArray()).toEqual(humanoid.normalizedRestPose[name]!.position);
            expect(bone.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        }
    });
});

describe('VRM idle animation', () => {
    test.each([1, -1])('keeps feet planted and arms relaxed throughout motion on rig axis %s', (forward) => {
        const { root, humanoid } = createHumanoid(forward, 1, false);
        applyVrmRelaxedPose(humanoid);
        const animate = createVrmIdleAnimation(humanoid);
        humanoid.update();
        const position = (name: VRMHumanBoneName) => humanoid.getRawBoneNode(name)!.getWorldPosition(new Vector3());
        const feet = [position('leftFoot'), position('rightFoot')];
        const initialHead = position('head');
        let headMovement = 0;
        for (let elapsed = 0; elapsed <= 30; elapsed += 0.25) {
            animate(elapsed);
            humanoid.update();
            root.updateMatrixWorld(true);
            headMovement = Math.max(headMovement, position('head').distanceTo(initialHead));
            for (const [index, side] of (['left', 'right'] as const).entries()) {
                expect(position(`${side}Foot`).distanceTo(feet[index])).toBeLessThan(1e-6);
                const upper = position(`${side}UpperArm`);
                const lower = position(`${side}LowerArm`);
                const hand = position(`${side}Hand`);
                expect(lower.sub(upper).normalize().y).toBeLessThan(-0.9);
                expect(hand.y).toBeLessThan(position(`${side}LowerArm`).y);
            }
        }
        expect(headMovement).toBeGreaterThan(0.005);
        expect(headMovement).toBeLessThan(0.06);
    });

    test('restores the base pose for reduced motion or capture and resumes without drift', () => {
        const { humanoid } = createHumanoid(1, 1);
        applyVrmRelaxedPose(humanoid);
        const animate = createVrmIdleAnimation(humanoid);
        const pose = () => humanoid.getNormalizedPose();
        const rest = pose();
        animate(4);
        const moving = pose();
        expect(moving).not.toEqual(rest);
        for (let elapsed = 0; elapsed < 60; elapsed += 0.1) animate(elapsed);
        animate(60, false);
        expect(pose()).toEqual(rest);
        animate(4);
        expect(pose()).toEqual(moving);
    });
});
